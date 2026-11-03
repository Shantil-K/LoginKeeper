#!/bin/sh
# Login Keeper: backs up and restores the web-app login data (cookies, local storage,
# IndexedDB...) that webOS keeps in /var/lib/wam/Default. Runs as root through
# Homebrew Channel. Usage: loginkeeper.sh <command> [args]
#   status | list | backup [manual|auto] | restore NAME | delete NAME | protect NAME on|off
#   set KEY VALUE | apps all|ORIGIN... | autostart on|off | daemon
# Backups always hold everything; the "apps" choice decides what a restore puts back.

WAM=/var/lib/wam/Default
ROOT=/media/developer/loginkeeper
BK=$ROOT/backups
TMP=$ROOT/tmp
CONF=$ROOT/config
LOG=$ROOT/log.txt
BASE=$ROOT/baseline
WIPED=$ROOT/wipe-detected
SELF=$ROOT/loginkeeper.sh
LSDB=$ROOT/lsdb.js
APPS=$ROOT/apps   # origins to restore, one per line; missing = all apps
INITD=/var/lib/webosbrew/init.d/50-loginkeeper
PIDFILE=$ROOT/daemon.pid
LAUNCHERS=" com.webos.app.home com.homebrew.openlauncher com.homebrew.loginkeeper "

# Storage that holds logins. Caches are left out: they are big and rebuild themselves.
ITEMS="Local_Storage IndexedDB Cookies Cookies-journal Service_Worker/Database Service_Worker/ScriptCache File_System WebStorage AppsOrigins AppsOrigins-journal databases"

# Defaults, overridden by $CONF
KEEP=13         # automatic backups to keep: 13 x 6 hours = 78 hours of history (manual ones are kept until deleted)
INTERVAL_H=6    # hours between automatic backups
AUTORESTORE=1   # restore the newest backup by itself when a wipe is detected

mkdir -p "$BK" "$TMP"
[ -f "$CONF" ] && . "$CONF"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
trimlog() { [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 300 ] && { tail -n 200 "$LOG" > "$LOG.t"; mv "$LOG.t" "$LOG"; }; }
toast() { luna-send -n 1 -a com.webos.service.secondscreen.gateway luna://com.webos.notification/createToast "{\"sourceId\":\"com.homebrew.loginkeeper\",\"message\":\"$1\"}" >/dev/null 2>&1; }
jstr() { printf '%s' "$1" | awk 'BEGIN{ORS=""; printf "\""} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/," "); if (NR>1) printf "\\n"; print} END{printf "\""}'; }
validname() { case "$1" in ""|*[!0-9A-Za-z_-]*) echo '{"ok":false,"error":"bad name"}'; exit 1;; esac; [ -f "$BK/$1.tgz" ] || { echo '{"ok":false,"error":"no such backup"}'; exit 1; }; }

# Inode of the local-storage database folder. Chromium deletes and recreates this folder
# when it wipes storage; normal use never does, so a new inode means a wipe.
lsinode() { stat -c %i "$WAM/Local Storage/leveldb" 2>/dev/null || echo none; }
# A marker file next to the database: Chromium deletes the whole "Local Storage" folder when
# it wipes, so a missing marker means a wipe even if the new folder reuses the old inode.
MARK="$WAM/Local Storage/.loginkeeper"
markok() { [ -d "$WAM/Local Storage" ] && { touch "$MARK"; chown "$(stat -c %U:%G "$WAM")" "$MARK"; }; lsinode > "$BASE"; }
iswiped() { [ -f "$BASE" ] && { [ ! -f "$MARK" ] || [ "$(lsinode)" != "$(cat "$BASE")" ]; }; }

# Main WebAppMgr process (the browser process that owns storage), not the renderers
wampid() { for p in $(pidof WebAppMgr); do grep -q -- '--type=' /proc/$p/cmdline 2>/dev/null || echo $p; done; }

# Apps (origins) that have saved data in a profile copy at $1. Prints one per line.
origins() {
	d="$1"
	o=$(node "$LSDB" origins "$d/Local Storage/leveldb" 2>/dev/null) && case "$o" in *'"ok":true'*) ;; *) o="";; esac
	if [ -n "$o" ]; then
		{ echo "$o" | grep -oE '"[a-z]+://[^"]+":\{' | sed 's/^"//; s/":{$//'
		  ls "$d/IndexedDB" 2>/dev/null | sed -nE 's/^(https?|file)_(.*)_[0-9]+\.indexeddb\.leveldb$/\1:\/\/\2/p'; } | sort -u
		return
	fi
	{
		cat "$d/Local Storage/leveldb/"*.ldb "$d/Local Storage/leveldb/"*.log 2>/dev/null | strings | grep -oE '^(META:|_)(https?|file)://[^ ]+' | sed -E 's/^(META:|_)//; s/[^A-Za-z0-9.:\/_-].*$//'
		ls "$d/IndexedDB" 2>/dev/null | grep -E '\.indexeddb\.leveldb$' | sed -E 's/^(https?|file)_(.*)_[0-9]+\.indexeddb\.leveldb$/\1:\/\/\2/'
	} | sed -E 's#^file://([^/]*)-webos.*#file://\1#; s#^file://(.*)-(w|)$#file://\1#' | grep -vE 'com\.webos\.app\.|lgtvcommon|^file://$' | sort -u
}

# Rough "is YouTube signed in" check: YouTube keeps the signed-in accounts under this key
ytsigned() {
	node "$LSDB" dump "$1/Local Storage/leveldb" 2>/dev/null | grep -q '^._https://www.youtube.com.x00.x01yt.leanback.default::available-identities' && { echo true; return; }
	cat "$1/Local Storage/leveldb/"* 2>/dev/null | strings | grep -q 'available-identities' && echo true || echo false
}

# Cookie sites that belong to an app's origin, as an SQL condition on host_key
cookiecond() {
	c=""
	for o in "$@"; do
		h=${o#*://}; h=${h%%/*}; doms=""
		case "$o" in
		*www.youtube.com|*accounts.google.com|*tv.youtube.com) doms="youtube.com google.com" ;;
		file://*) # packaged app: match its brand name (longest part of the app id) in cookie sites
			t=$(echo "${h%-webos}" | tr . '\n' | sed 's/[0-9]*$//' | awk '{ if (length($0) > length(b)) b=$0 } END { print b }')
			[ ${#t} -ge 5 ] && c="$c OR host_key LIKE '%$t%'" ;;
		*) doms=$(echo "$h" | awk -F. '{ if (NF>2 && length($(NF-1))<=3) print $(NF-2)"."$(NF-1)"."$NF; else if (NF>=2) print $(NF-1)"."$NF; else print $0 }') ;;
		esac
		for d in $doms; do c="$c OR host_key='$d' OR host_key LIKE '%.$d'"; done
	done
	echo "${c# OR }"
}

cookiecount() { sqlite3 -readonly "$1/Cookies" 'select count(*) from cookies' 2>/dev/null || echo 0; }

copyitems() { # $1 from profile dir, $2 to dir
	for i in $ITEMS; do
		n=$(echo "$i" | tr _ ' ')
		[ -e "$1/$n" ] || continue
		mkdir -p "$2/$(dirname "$n")"
		cp -a "$1/$n" "$2/$(dirname "$n")/" || return 1
	done
}

writemeta() { # $1 name, $2 kind, $3 profile copy dir
	o=$(origins "$3"); first=1; list=""
	for x in $o; do [ $first = 1 ] && first=0 || list="$list,"; list="$list$(jstr "$x")"; done
	size=$(stat -c %s "$BK/$1.tgz")
	printf '{"name":"%s","kind":"%s","time":%s,"size":%s,"cookies":%s,"youtube":%s,"origins":[%s]}\n' \
		"$1" "$2" "$(date +%s)" "$size" "$(cookiecount "$3")" "$(ytsigned "$3")" "$list" > "$BK/$1.json"
}

# Make a backup. Freezes the web-app engine for the fraction of a second the plain copy
# takes, so the databases are not caught half-written, then compresses at low priority.
dobackup() {
	kind="$1"
	if restoring; then log "backup skipped: a restore is running"; echo '{"ok":false,"error":"a restore is running"}'; return 1; fi
	[ "$(df -m "$ROOT" | awk 'NR==2{print $4}')" -lt 100 ] && { log "backup skipped: less than 100 MB free"; echo '{"ok":false,"error":"less than 100 MB free"}'; return 1; }
	name="$(date +%Y%m%d-%H%M%S)-$kind"
	work="$TMP/$name"; rm -rf "$work"; mkdir -p "$work"
	pid=$(wampid)
	[ -n "$pid" ] && kill -STOP $pid
	copyitems "$WAM" "$work"; rc=$?
	[ -n "$pid" ] && kill -CONT $pid
	[ $rc = 0 ] || { rm -rf "$work"; log "backup failed while copying"; echo '{"ok":false,"error":"copy failed"}'; return 1; }
	nice -n 19 tar czf "$BK/$name.tgz.part" -C "$work" . && mv "$BK/$name.tgz.part" "$BK/$name.tgz" || { rm -rf "$work" "$BK/$name.tgz.part"; log "backup failed while compressing"; echo '{"ok":false,"error":"compress failed"}'; return 1; }
	writemeta "$name" "$kind" "$work"
	rm -rf "$work"
	# an automatic backup only runs on healthy storage; a manual one means "this state is good"
	if [ "$kind" = manual ]; then markok; rm -f "$WIPED" "$WIPED.told"; fi
	[ -f "$BASE" ] || markok
	rotate
	log "backup $name made ($(stat -c %s "$BK/$name.tgz") bytes)"
	echo "{\"ok\":true,\"name\":\"$name\"}"
}

# Keep the newest $KEEP automatic backups; manual, pre-restore and protected ones stay
rotate() {
	ls "$BK" | grep -E '^[0-9]{8}-[0-9]{6}-auto\.tgz$' | sort -r | tail -n +$((KEEP+1)) | while read f; do
		b="${f%.tgz}"; [ -f "$BK/$b.keep" ] && continue
		rm -f "$BK/$b.tgz" "$BK/$b.json"; log "old backup $b removed"
	done
	# pre-restore snapshots: keep the newest 2
	ls "$BK" | grep -E '\-prerestore\.tgz$' | sort -r | tail -n +3 | while read f; do b="${f%.tgz}"; rm -f "$BK/$b.tgz" "$BK/$b.json"; done
}

newestgood() { # newest backup that is not a pre-restore snapshot
	ls "$BK" | grep -E '^[0-9]{8}-[0-9]{6}-(auto|manual)\.tgz$' | sort -r | head -n 1 | sed 's/\.tgz$//'
}

# True while a restore is running (it holds restore.lock)
restoring() { [ -f "$ROOT/restore.lock" ] && ! flock -n "$ROOT/restore.lock" true 2>/dev/null; }

# Restore runs detached: stopping the web-app engine also closes the app that asked for it.
# It runs in a subshell so its lock is released when it ends, even when the daemon called it.
dorestore() { ( restore_now "$@" ); }
restore_now() {
	name="$1"; relaunch="$2"
	exec 9>"$ROOT/restore.lock"; flock -n 9 || { log "restore already running"; return 1; }
	log "restore of $name started"
	rm -rf "$TMP/restore"; mkdir -p "$TMP/restore"
	tar xzf "$BK/$name.tgz" -C "$TMP/restore" && [ -e "$TMP/restore/Cookies" -o -e "$TMP/restore/Local Storage" ] || { log "restore failed: archive unreadable"; toast "Login Keeper: restore failed (backup unreadable)"; return 1; }
	# safety copy of what is there now, so a restore can be undone
	pre="$(date +%Y%m%d-%H%M%S)-prerestore"; mkdir -p "$TMP/$pre"
	systemctl stop webapp-mgr
	n=0; while [ -n "$(pidof WebAppMgr)" ] && [ $n -lt 20 ]; do sleep 1; n=$((n+1)); done
	[ -n "$(pidof WebAppMgr)" ] && { killall -9 WebAppMgr; sleep 1; }
	copyitems "$WAM" "$TMP/$pre"
	owner=$(stat -c %U:%G "$WAM")
	picked=$(cat "$APPS" 2>/dev/null | grep -E '^[a-z]+://[A-Za-z0-9._:/-]+$')
	if [ -z "$picked" ]; then
		# all apps: put the whole saved storage back
		for i in $ITEMS; do
			n=$(echo "$i" | tr _ ' ')
			rm -rf "$WAM/$n"
		done
		cp -a "$TMP/restore/." "$WAM/"
		what="all apps"
	else
		mergeapps $picked || { chown -R "$owner" "$WAM"; systemctl start webapp-mgr; rm -rf "$TMP/$pre" "$TMP/restore"; toast "Login Keeper: restore failed, nothing was changed"; return 1; }
		what="$(echo $picked | wc -w) chosen apps"
	fi
	chown -R "$owner" "$WAM"
	sync
	systemctl start webapp-mgr
	markok; rm -f "$WIPED"
	( nice -n 19 tar czf "$BK/$pre.tgz" -C "$TMP/$pre" . && writemeta "$pre" prerestore "$TMP/$pre"; rm -rf "$TMP/$pre" "$TMP/restore"; rotate )
	log "restore of $name done ($what)"
	sleep 4
	toast "Login Keeper: logins restored from $(echo "$name" | sed -E 's/^(....)(..)(..)-(..)(..).*/\3-\2-\1 \4:\5/')"
	[ -n "$relaunch" ] && luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"$relaunch\"}" >/dev/null 2>&1
}

# Put back only the chosen apps' data (web-app engine must be stopped). Each app's keys in the
# shared Local Storage database are swapped by lsdb.js; IndexedDB folders and cookies per site.
mergeapps() {
	R="$TMP/restore"
	rm -rf "$TMP/newls"
	res=$(node "$LSDB" merge "$WAM/Local Storage/leveldb" "$R/Local Storage/leveldb" "$TMP/newls" "$@" 2>&1)
	case "$res" in *'"ok":true'*) ;; *) log "restore failed: local storage merge: $res"; rm -rf "$TMP/newls"; return 1;; esac
	rm -rf "$WAM/Local Storage/leveldb"; mkdir -p "$WAM/Local Storage"
	mv "$TMP/newls" "$WAM/Local Storage/leveldb"
	mkdir -p "$WAM/IndexedDB"
	for o in "$@"; do
		n=$(echo "$o" | sed 's#://#_#')
		for sfx in _0.indexeddb.leveldb _0.indexeddb.blob; do
			rm -rf "$WAM/IndexedDB/$n$sfx"
			[ -e "$R/IndexedDB/$n$sfx" ] && cp -a "$R/IndexedDB/$n$sfx" "$WAM/IndexedDB/"
		done
	done
	cond=$(cookiecond "$@")
	if [ -n "$cond" ] && [ -f "$R/Cookies" ]; then
		if [ -f "$WAM/Cookies" ]; then
			sqlite3 "$WAM/Cookies" "ATTACH '$R/Cookies' AS b; BEGIN; DELETE FROM main.cookies WHERE $cond; INSERT OR REPLACE INTO main.cookies SELECT * FROM b.cookies WHERE $cond; COMMIT;" 2>>"$LOG" || log "cookies were not merged"
		else
			cp "$R/Cookies" "$WAM/Cookies" && sqlite3 "$WAM/Cookies" "DELETE FROM cookies WHERE NOT ($cond);" 2>>"$LOG"
		fi
	fi
	log "put back data of $# origins ($(echo "$res" | grep -oE '"fromBackup":[0-9]+' | cut -d: -f2) saved entries)"
	return 0
}

fgapp() { luna-send -n 1 luna://com.webos.applicationManager/getForegroundAppInfo '{}' 2>/dev/null | grep -oE '"appId":"[^"]*"' | cut -d'"' -f4; }

# Background loop, started at boot from Homebrew Channel's init.d
daemon() {
	exec 8>"$ROOT/daemon.lock"; flock -n 8 || exit 0
	echo $$ > "$PIDFILE"
	log "protection started"
	sleep ${LK_BOOTWAIT:-60}   # let the TV finish booting
	while :; do
		[ -f "$CONF" ] && . "$CONF"
		# mid-restore the storage is being swapped: neither a backup nor a wipe check makes sense
		if restoring; then sleep 60 8>&-; continue; fi
		if iswiped; then
			# storage was recreated: never back it up, offer or do a restore
			if [ ! -f "$WIPED" ]; then date +%s > "$WIPED"; log "login data was reset (storage recreated)"; fi
			good=$(newestgood)
			if [ -n "$good" ] && [ "$AUTORESTORE" = 1 ]; then
				# only restore while on the home screen: it closes every web app for a few seconds
				fg=$(fgapp); athome=0
				case "$LAUNCHERS" in *" $fg "*) athome=1;; esac
				[ -z "$fg" ] && athome=1
				# at most one automatic restore per 30 minutes, in case a backup itself gets wiped again
				lr=$(cat "$ROOT/last-autorestore" 2>/dev/null || echo 0)
				if [ $(( $(date +%s) - lr )) -lt 1800 ]; then
					[ -f "$WIPED.told" ] || { touch "$WIPED.told"; log "wiped again right after a restore; waiting for you"; toast "Login Keeper: logins were reset again right after a restore. Open Login Keeper to pick a backup."; }
				elif [ $athome = 1 ]; then date +%s > "$ROOT/last-autorestore"; log "auto-restoring $good"; dorestore "$good" "$fg"
				elif [ ! -f "$WIPED.told" ]; then touch "$WIPED.told"; toast "Login Keeper: app logins were reset. They will be restored when you go back to the home screen."; fi
			elif [ ! -f "$WIPED.told" ]; then touch "$WIPED.told"; toast "Login Keeper: app logins were reset. Open Login Keeper to restore them."; fi
		else
			rm -f "$WIPED" "$WIPED.told"
			last=$(ls "$BK" | grep -E -- '-auto\.tgz$' | sort -r | head -n 1)
			lt=0; [ -n "$last" ] && lt=$(stat -c %Y "$BK/$last")
			if [ $(( $(date +%s) - lt )) -ge $(( INTERVAL_H * 3600 )) ]; then
				dobackup auto >/dev/null
			fi
		fi
		trimlog
		sleep 300 8>&-
	done
}

daemonrunning() { p=$(cat "$PIDFILE" 2>/dev/null); [ -n "$p" ] && [ -d "/proc/$p" ] && grep -q loginkeeper "/proc/$p/cmdline" 2>/dev/null && echo true || echo false; }

startdaemon() { [ "$(daemonrunning)" = true ] || setsid nohup /bin/sh "$SELF" daemon </dev/null >/dev/null 2>&1 & }

case "$1" in
status)
	[ -f "$BASE" ] || [ -z "$(newestgood)" ] || markok
	wiped=null; [ -f "$WIPED" ] && wiped=$(cat "$WIPED")
	free=$(df -m "$ROOT" | awk 'NR==2{print $4}')
	apps="null"; [ -s "$APPS" ] && apps="[$(sed 's/.*/"&"/' "$APPS" | tr '\n' ',' | sed 's/,$//')]"
	printf '{"ok":true,"apps":%s,"daemon":%s,"autostart":%s,"autorestore":%s,"keep":%s,"interval":%s,"wiped":%s,"freeMB":%s,"liveYoutube":%s,"log":%s}\n' \
		"$apps" "$(daemonrunning)" "$([ -f "$INITD" ] && echo true || echo false)" "$([ "$AUTORESTORE" = 1 ] && echo true || echo false)" \
		"$KEEP" "$INTERVAL_H" "$wiped" "${free:-0}" "$(ytsigned "$WAM")" "$(jstr "$(tail -n 12 "$LOG" 2>/dev/null)")"
	;;
list)
	printf '{"ok":true,"backups":['; first=1
	for j in $(ls "$BK" | grep '\.json$' | sort -r); do
		b="${j%.json}"; [ -f "$BK/$b.tgz" ] || continue
		[ $first = 1 ] && first=0 || printf ','
		k=false; [ -f "$BK/$b.keep" ] && k=true
		sed "s/}\$/,\"keep\":$k}/" "$BK/$j" | tr -d '\n'
	done
	printf ']}\n'
	;;
backup) exec 9>"$ROOT/backup.lock"; flock -w 30 9; dobackup "${2:-manual}" ;;
restore)
	validname "$2"
	setsid nohup /bin/sh "$SELF" do-restore "$2" "$3" </dev/null >>"$LOG" 2>&1 &
	echo '{"ok":true,"started":true}'
	;;
do-restore) dorestore "$2" "$3" ;;
delete) validname "$2"; rm -f "$BK/$2.tgz" "$BK/$2.json" "$BK/$2.keep"; log "backup $2 deleted"; echo '{"ok":true}' ;;
apps)
	shift
	if [ "$1" = all ] || [ -z "$1" ]; then rm -f "$APPS"; log "restore covers all apps"
	else
		: > "$APPS.t"
		for o in "$@"; do echo "$o" | grep -qE '^[a-z]+://[A-Za-z0-9._:/-]+$' && echo "$o" >> "$APPS.t"; done
		mv "$APPS.t" "$APPS"; log "restore covers $(wc -l < "$APPS") chosen apps"
	fi
	echo '{"ok":true}'
	;;
protect) validname "$2"; if [ "$3" = on ]; then touch "$BK/$2.keep"; else rm -f "$BK/$2.keep"; fi; echo '{"ok":true}' ;;
set)
	case "$2" in KEEP|INTERVAL_H|AUTORESTORE) ;; *) echo '{"ok":false,"error":"bad key"}'; exit 1;; esac
	case "$3" in ""|*[!0-9]*) echo '{"ok":false,"error":"bad value"}'; exit 1;; esac
	touch "$CONF"; grep -v "^$2=" "$CONF" > "$CONF.t"; echo "$2=$3" >> "$CONF.t"; mv "$CONF.t" "$CONF"
	echo '{"ok":true}'
	;;
autostart)
	if [ "$2" = on ]; then
		mkdir -p "$(dirname "$INITD")"
		printf '#!/bin/sh\n# Login Keeper background protection\n[ -f %s ] && setsid nohup /bin/sh %s daemon </dev/null >/dev/null 2>&1 &\nexit 0\n' "$SELF" "$SELF" > "$INITD"
		chmod 755 "$INITD"
		[ -f "$BASE" ] || markok
		startdaemon; log "protection turned on"
	else
		rm -f "$INITD"
		p=$(cat "$PIDFILE" 2>/dev/null); [ "$(daemonrunning)" = true ] && { pkill -P "$p" 2>/dev/null; kill "$p"; }
		log "protection turned off"
	fi
	echo '{"ok":true}'
	;;
install) # copy this script next to the backups so the boot hook keeps working across app updates
	src="$2"; [ -f "$src" ] && [ "$src" != "$SELF" ] && cp "$src" "$SELF.new" && mv "$SELF.new" "$SELF" && chmod 755 "$SELF"
	js="$(dirname "$src")/lsdb.js"; [ -f "$js" ] && [ "$js" != "$LSDB" ] && cp "$js" "$LSDB"
	if [ -f "$INITD" ] && [ "$(daemonrunning)" = false ]; then startdaemon; fi
	echo '{"ok":true}'
	;;
daemon) daemon ;;
*) echo '{"ok":false,"error":"unknown command"}'; exit 1 ;;
esac
