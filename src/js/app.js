// Login Keeper UI. All the work is done by loginkeeper.sh, run as root through Homebrew Channel.
// Kept to Chromium 79 syntax (webOS 22).
"use strict";

var APP_ID = "com.homebrew.loginkeeper";
var APP_DIR = decodeURIComponent(location.pathname).replace(/\/[^\/]*$/, "");
var SCRIPT = "/media/developer/loginkeeper/loginkeeper.sh";

var NAMES = {
	"www.youtube.com": "YouTube", "livingroom.hotstar.com": "JioHotstar", "lg.zee5.com": "ZEE5",
	"com.sonyliv2.tvapp": "SonyLIV", "com.homebrew.openlauncher": "OpenLauncher", "kinoflex.ru": "Kinoflex",
	"com.twin.app.gamingportal": "Gaming portal", "com.blacknutlgpromoo2.app": "Blacknut",
	"com.mydomain.minesweeper": "Minesweeper", "org.jellyfin.webos": "Jellyfin", "www.primevideo.com": "Prime Video",
	"tv.twitch.tv": "Twitch", "airtelxstream.in": "Airtel Xstream", "data.bambagames.com": "Bamba Games", "www.twitch.tv": "Twitch", "open.spotify.com": "Spotify", "tv.youtube.com": "YouTube TV"
};
// Origins that make up one app (YouTube signs in through accounts.google.com)
var GROUPS = [
	{ name: "YouTube", origins: ["https://www.youtube.com", "https://accounts.google.com", "https://tv.youtube.com"] },
	{ name: "JioHotstar", origins: ["https://livingroom.hotstar.com", "https://h5.jiocinema.com"] }
];
// TV system screens and helpers that are not apps you sign in to
var HIDDEN = [/^file:\/\/com\.webos\./, /lgtvcommon\.com/, /sonic\.xapp\.avs\.amazon\.dev/, /com\.homebrew\.loginkeeper/];
var KINDS = { manual: "Manual", auto: "Automatic", prerestore: "Before a restore" };

var state = { status: null, backups: [] };

function $(id) { return document.getElementById(id); }

// ---- root commands -------------------------------------------------------------------------

function execRoot(command, timeoutMs) {
	return new Promise(function (resolve, reject) {
		if (!window.PalmServiceBridge) { reject(new Error("Not running on a webOS TV")); return; }
		var bridge = new window.PalmServiceBridge();
		var done = false;
		var timer = setTimeout(function () { if (!done) { done = true; reject(new Error("The TV did not answer")); } }, timeoutMs || 60000);
		bridge.onservicecallback = function (payload) {
			if (done) return;
			done = true; clearTimeout(timer);
			var res;
			try { res = JSON.parse(payload); } catch (e) { reject(new Error("Bad answer from the TV")); return; }
			if (res.returnValue === false) {
				reject(new Error(res.errorText || "Homebrew Channel could not run the command. Is the TV rooted?"));
				return;
			}
			resolve(res);
		};
		bridge.call("luna://org.webosbrew.hbchannel.service/exec", JSON.stringify({ command: command }));
	});
}

function quote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function run(args, timeoutMs) {
	return execRoot("sh " + SCRIPT + " " + args, timeoutMs).then(function (res) {
		var out = (res.stdoutString || "").trim().split("\n").pop();
		var data;
		try { data = JSON.parse(out); } catch (e) { throw new Error((res.stderrString || out || "No answer").slice(0, 200)); }
		if (!data.ok) throw new Error(data.error || "Failed");
		return data;
	});
}

// ---- helpers ---------------------------------------------------------------------------------

function appName(origin) {
	for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].origins.indexOf(origin) >= 0) return GROUPS[i].name;
	var host = origin.replace(/^[a-z]+:\/\//, "").replace(/-webos$/, "");
	if (NAMES[host]) return NAMES[host];
	if (/^file:/.test(origin)) { // packaged app id like com.brand.app: use its longest part
		var best = host.split(".").filter(function (p) { return !/^(com|org|net|app|tv|webos|lgwebos)$/.test(p); })
			.sort(function (a, b) { return b.length - a.length; })[0] || host;
		return best.charAt(0).toUpperCase() + best.slice(1);
	}
	return host.replace(/^www\./, "");
}

function pad(n) { return n < 10 ? "0" + n : "" + n; }
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(sec) {
	var d = new Date(sec * 1000);
	return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function ago(sec) {
	var s = Math.max(0, Date.now() / 1000 - sec);
	if (s < 90) return "just now";
	if (s < 5400) return Math.round(s / 60) + " minutes ago";
	if (s < 129600) return Math.round(s / 3600) + " hours ago";
	return Math.round(s / 86400) + " days ago";
}
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB"; }

function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function toast(msg) {
	if (!window.PalmServiceBridge) return;
	new window.PalmServiceBridge().call("luna://com.webos.notification/createToast", JSON.stringify({ message: msg }));
}

// Apps (name -> origins) found in any backup, without system screens
function knownApps() {
	var map = {}, order = [];
	state.backups.forEach(function (b) {
		(b.origins || []).forEach(function (o) {
			if (HIDDEN.some(function (re) { return re.test(o); })) return;
			var n = appName(o);
			if (!map[n]) { map[n] = []; order.push(n); }
			if (map[n].indexOf(o) < 0) map[n].push(o);
		});
	});
	order.sort(function (a, b) { return a === "YouTube" ? -1 : b === "YouTube" ? 1 : a.localeCompare(b); });
	return order.map(function (n) { return { name: n, origins: map[n] }; });
}

function chosenNames() { // null = all apps
	var picked = state.status && state.status.apps;
	if (!picked) return null;
	var names = [];
	picked.forEach(function (o) { var n = appName(o); if (names.indexOf(n) < 0) names.push(n); });
	return names;
}

function renderApps() {
	var box = $("apps"), apps = knownApps(), chosen = chosenNames();
	var focusedApp = document.activeElement && document.activeElement.getAttribute("data-app");
	box.innerHTML = "";
	function chip(label, on, key) {
		var b = document.createElement("button");
		b.className = "nav " + (on ? "on" : "off");
		b.setAttribute("data-app", key);
		b.innerHTML = '<span class="dot"></span>' + esc(label);
		box.appendChild(b);
	}
	chip("All apps", !chosen, "*");
	apps.forEach(function (a) { chip(a.name, !chosen || chosen.indexOf(a.name) >= 0, a.name); });
	if (focusedApp) { var again = box.querySelector('[data-app="' + focusedApp.replace(/"/g, "") + '"]'); if (again) again.focus(); }
}

function toggleApp(key) {
	var apps = knownApps(), chosen = chosenNames();
	var names;
	if (key === "*") { if (!chosen) return; names = null; }
	else {
		names = chosen ? chosen.slice() : apps.map(function (a) { return a.name; });
		var i = names.indexOf(key);
		if (i >= 0) names.splice(i, 1); else names.push(key);
	}
	var args;
	if (!names) args = "all";
	else {
		if (!names.length) { toast("Pick at least one app"); return; }
		var origins = [];
		apps.forEach(function (a) { if (names.indexOf(a.name) >= 0) origins = origins.concat(a.origins); });
		// a YouTube choice always brings its sign-in origin along
		GROUPS.forEach(function (g) { if (names.indexOf(g.name) >= 0) g.origins.forEach(function (o) { if (origins.indexOf(o) < 0) origins.push(o); }); });
		args = origins.map(quote).join(" ");
	}
	run("apps " + args).then(refresh).catch(showError);
}

function chosenLabel() {
	var c = chosenNames();
	if (!c) return "all apps";
	return c.length > 3 ? c.slice(0, 3).join(", ") + " and " + (c.length - 3) + " more" : c.join(", ");
}

// ---- rendering -------------------------------------------------------------------------------

function renderStatus() {
	var st = state.status, line = $("statusline"), det = $("statusdetail");
	if (!st) return;
	var newest = state.backups.filter(function (b) { return b.kind !== "prerestore"; })[0];
	line.className = "statusline";
	if (st.wiped) {
		line.textContent = "App logins were reset on " + fmtDate(st.wiped);
		line.classList.add("bad");
	} else if (st.autostart && st.daemon) {
		line.textContent = "Protected";
		line.classList.add("good");
	} else if (st.autostart) {
		line.textContent = "Protection is on, starting…";
		line.classList.add("warn");
	} else {
		line.textContent = "Automatic protection is off";
		line.classList.add("warn");
	}
	var parts = [];
	parts.push(newest ? "Last backup " + ago(newest.time) : "No backups yet");
	parts.push("YouTube is " + (st.liveYoutube ? "signed in" : "not signed in") + " right now");
	if (st.autostart) parts.push("backs up every " + st.interval + " hours, keeps " + st.keep);
	parts.push(st.freeMB + " MB free");
	det.textContent = parts.join("  ·  ");

	setToggle($("btnprotect"), st.autostart);
	setToggle($("btnautorestore"), st.autorestore);
	$("log").textContent = (st.log || "Nothing yet.").split("\n").reverse().slice(0, 3).join("\n");
}

function setToggle(btn, on) {
	btn.classList.toggle("on", !!on);
	btn.classList.toggle("off", !on);
	btn.querySelector(".val").textContent = on ? "On" : "Off";
}

function renderList() {
	var list = $("list");
	var focusedName = document.activeElement && document.activeElement.getAttribute("data-name");
	var focusedAct = document.activeElement && document.activeElement.getAttribute("data-act");
	list.innerHTML = "";
	if (!state.backups.length) {
		list.innerHTML = '<div class="empty">No backups yet. Press "Back up now" while your apps are signed in.</div>';
		return;
	}
	state.backups.forEach(function (b) {
		var chosen = chosenNames();
		var apps = (b.origins || []).filter(function (o) { return !HIDDEN.some(function (re) { return re.test(o); }); })
			.map(appName).filter(function (n, i, a) { return a.indexOf(n) === i; });
		// one line: the apps that a restore would bring back first, then a count of the rest
		var mine = apps.filter(function (n) { return !chosen || chosen.indexOf(n) >= 0; })
			.sort(function (x, y) { return x === "YouTube" ? -1 : y === "YouTube" ? 1 : x.localeCompare(y); });
		var shown = mine.slice(0, 4), more = apps.length - shown.length;
		var appsHtml = shown.map(function (n) {
			return '<span class="chosen">' + esc(n === "YouTube" && b.youtube ? "YouTube (signed in)" : n) + "</span>";
		}).join(", ") + (more > 0 ? (shown.length ? " · " : "") + "+" + more + (shown.length ? " more" : " apps, none chosen") : "");
		var row = document.createElement("div");
		row.className = "item";
		row.innerHTML =
			'<div class="when"><b>' + esc(fmtDate(b.time)) + "</b><span>" + esc(KINDS[b.kind] || b.kind) + " · " + fmtSize(b.size) + "</span>" +
			(b.keep ? '<span class="tag keep">Kept</span>' : "") + "</div>" +
			'<div class="apps">' + (appsHtml || "No app data") + "</div>" +
			'<button class="nav" data-act="restore" data-name="' + esc(b.name) + '">Restore</button>' +
			(b.kind === "auto" ? '<button class="nav" data-act="keep" data-name="' + esc(b.name) + '">' + (b.keep ? "Don't keep" : "Keep") + "</button>" : "") +
			'<button class="nav danger" data-act="delete" data-name="' + esc(b.name) + '">Delete</button>';
		list.appendChild(row);
	});
	if (focusedName) {
		var again = list.querySelector('[data-name="' + focusedName + '"][data-act="' + focusedAct + '"]') || list.querySelector("button");
		if (again) again.focus();
	}
	if (!document.activeElement || document.activeElement === document.body) $("btnbackup").focus();
}

function refresh() {
	return Promise.all([run("status"), run("list")]).then(function (r) {
		state.status = r[0];
		state.backups = r[1].backups || [];
		renderApps();
		renderList();
		renderStatus();
	}).catch(showError);
}

function showError(e) {
	var line = $("statusline");
	line.className = "statusline bad";
	line.textContent = "Can't reach the TV's root tools";
	$("statusdetail").textContent = (e && e.message ? e.message : String(e)) + ". Login Keeper needs a rooted TV with Homebrew Channel.";
}

// ---- dialogs ---------------------------------------------------------------------------------

var dialogResolve = null, dialogReturnFocus = null;
function confirmBox(text, yesLabel) {
	dialogReturnFocus = document.activeElement;
	$("dialogtext").textContent = text;
	$("dialogyes").textContent = yesLabel || "Yes";
	$("dialog").classList.remove("hidden");
	$("dialogno").focus();
	return new Promise(function (resolve) { dialogResolve = resolve; });
}
function closeDialog(answer) {
	$("dialog").classList.add("hidden");
	if (dialogReturnFocus && document.body.contains(dialogReturnFocus)) dialogReturnFocus.focus();
	var r = dialogResolve; dialogResolve = null;
	if (r) r(answer);
}
function busy(text) {
	$("busytext").textContent = text || "";
	$("busy").classList.toggle("hidden", !text);
}

// ---- actions ---------------------------------------------------------------------------------

function backupNow() {
	busy("Backing up…");
	run("backup manual", 120000).then(function () {
		busy(null); toast("Login Keeper: backup made");
		return refresh();
	}).catch(function (e) { busy(null); showError(e); });
}

function restore(name) {
	var b = state.backups.filter(function (x) { return x.name === name; })[0];
	confirmBox("Restore " + chosenLabel() + " as saved on " + fmtDate(b.time) + "?" + (chosenNames() ? " Other apps are left as they are." : "") + " Every open web app (including this one) closes for about 10 seconds. What is there now is saved first, so you can undo it.", "Restore").then(function (yes) {
		if (!yes) return;
		busy("Restoring… the app will close and come back");
		run("restore " + quote(name) + " " + APP_ID).catch(function (e) { busy(null); showError(e); });
	});
}

function del(name) {
	var b = state.backups.filter(function (x) { return x.name === name; })[0];
	confirmBox("Delete the backup from " + fmtDate(b.time) + "?", "Delete").then(function (yes) {
		if (!yes) return;
		run("delete " + quote(name)).then(refresh).catch(showError);
	});
}

function keep(name) {
	var b = state.backups.filter(function (x) { return x.name === name; })[0];
	run("protect " + quote(name) + " " + (b.keep ? "off" : "on")).then(refresh).catch(showError);
}

function toggleProtect() {
	var on = !(state.status && state.status.autostart);
	run("autostart " + (on ? "on" : "off")).then(function () {
		// with no backup yet, make one straight away so there is something to restore
		if (on && !state.backups.some(function (b) { return b.kind !== "prerestore"; })) return run("backup manual", 120000);
	}).then(function () { setTimeout(refresh, 800); }).catch(showError);
}

function toggleAutoRestore() {
	var on = !(state.status && state.status.autorestore);
	run("set AUTORESTORE " + (on ? 1 : 0)).then(refresh).catch(showError);
}

// ---- remote control navigation ---------------------------------------------------------------

function focusables() {
	var scope = !$("dialog").classList.contains("hidden") ? $("dialog") : document;
	return Array.prototype.slice.call(scope.querySelectorAll("button.nav")).filter(function (el) { return el.offsetParent !== null; });
}

// Move to the nearest button in the pressed direction
function move(dir) {
	var all = focusables(), cur = document.activeElement;
	if (all.indexOf(cur) < 0) { if (all[0]) all[0].focus(); return; }
	var a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
	var best = null, bestScore = Infinity;
	all.forEach(function (el) {
		if (el === cur) return;
		var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
		var dx = x - ax, dy = y - ay, main, side;
		if (dir === "left") { main = -dx; side = Math.abs(dy); }
		else if (dir === "right") { main = dx; side = Math.abs(dy); }
		else if (dir === "up") { main = -dy; side = Math.abs(dx); }
		else { main = dy; side = Math.abs(dx); }
		if (main <= 4) return;
		if ((dir === "left" || dir === "right") && side > a.height) return; // stay on the same row
		var score = main + side * 3;
		if (score < bestScore) { bestScore = score; best = el; }
	});
	if (best) { best.focus(); best.scrollIntoView({ block: "nearest" }); }
}

document.addEventListener("keydown", function (e) {
	var k = e.keyCode;
	if (!$("busy").classList.contains("hidden")) { e.preventDefault(); return; }
	if (k === 37) move("left"); else if (k === 38) move("up"); else if (k === 39) move("right"); else if (k === 40) move("down");
	else if (k === 461 || k === 27 || k === 8) {
		if (!$("dialog").classList.contains("hidden")) closeDialog(false);
		else window.close();
	} else return;
	e.preventDefault();
});

document.addEventListener("click", function (e) {
	var t = e.target.closest("button");
	if (!t) return;
	if (t.id === "btnbackup") backupNow();
	else if (t.id === "btnprotect") toggleProtect();
	else if (t.id === "btnautorestore") toggleAutoRestore();
	else if (t.id === "dialogyes") closeDialog(true);
	else if (t.id === "dialogno") closeDialog(false);
	else if (t.dataset.act === "restore") restore(t.dataset.name);
	else if (t.dataset.act === "delete") del(t.dataset.name);
	else if (t.dataset.act === "keep") keep(t.dataset.name);
	else if (t.hasAttribute("data-app")) toggleApp(t.getAttribute("data-app"));
});

// Pointer (Magic Remote) hover moves focus too
document.addEventListener("mouseover", function (e) {
	var t = e.target.closest && e.target.closest("button.nav");
	if (t && focusables().indexOf(t) >= 0) t.focus();
});

document.addEventListener("webOSRelaunch", refresh);
document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });

// Start: copy the bundled script next to the backups (keeps the boot hook working across updates)
$("btnbackup").focus();
execRoot("mkdir -p /media/developer/loginkeeper && sh " + quote(APP_DIR + "/loginkeeper.sh") + " install " + quote(APP_DIR + "/loginkeeper.sh"))
	.then(refresh)
	.catch(showError);
setInterval(function () { if (!document.hidden && $("busy").classList.contains("hidden")) refresh(); }, 30000);
