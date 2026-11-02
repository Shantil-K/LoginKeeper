// Per-app editing of Chromium's Local Storage database (leveldb) for Login Keeper.
// Runs on the TV with its bundled Node (v16), while the web-app engine is stopped.
//
//   node lsdb.js origins DIR                 -> {"origins":{"<origin>":{"keys":n,"bytes":n}}}
//   node lsdb.js merge CUR BACKUP OUT ORIGIN...  -> OUT = CUR with ORIGIN's data taken from BACKUP
//   node lsdb.js dump DIR                    -> every live key and value (for testing)
//
// Keys look like "_<origin>\0<key>", "META:<origin>" and "METAACCESS:<origin>", so each app's
// data can be picked out by its origin. Reading follows the leveldb file formats (MANIFEST,
// .log write-ahead logs, .ldb tables with snappy blocks); writing makes a fresh database made of
// one MANIFEST and one .log, which leveldb replays and compacts on its next open.
"use strict";
const fs = require("fs");
const path = require("path");

// ---- small helpers --------------------------------------------------------------------------

function varint(buf, pos) { // returns [value, newPos]; values here stay below 2^53
	let result = 0, mul = 1, b;
	do {
		if (pos >= buf.length) throw new Error("truncated varint");
		b = buf[pos++];
		result += (b & 0x7f) * mul;
		mul *= 128;
	} while (b & 0x80);
	return [result, pos];
}
function lenPrefixed(buf, pos) {
	let n; [n, pos] = varint(buf, pos);
	return [buf.slice(pos, pos + n), pos + n];
}
function putVarint(arr, v) {
	while (v >= 128) { arr.push((v % 128) | 128); v = Math.floor(v / 128); }
	arr.push(v);
}

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
		t[i] = c;
	}
	return t;
})();
function crc32c(buf) {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (~c) >>> 0;
}
function maskCrc(c) { return ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0; }

function snappyDecompress(src) {
	let [len, pos] = varint(src, 0);
	const out = Buffer.alloc(len);
	let op = 0;
	while (pos < src.length) {
		const tag = src[pos++];
		const kind = tag & 3;
		if (kind === 0) {
			let n = tag >>> 2;
			if (n >= 60) {
				const bytes = n - 59; n = 0;
				for (let i = 0; i < bytes; i++) n |= src[pos++] << (8 * i);
				n >>>= 0;
			}
			n += 1;
			src.copy(out, op, pos, pos + n); pos += n; op += n;
		} else {
			let n, off;
			if (kind === 1) { n = ((tag >>> 2) & 7) + 4; off = ((tag >>> 5) << 8) | src[pos++]; }
			else if (kind === 2) { n = (tag >>> 2) + 1; off = src.readUInt16LE(pos); pos += 2; }
			else { n = (tag >>> 2) + 1; off = src.readUInt32LE(pos); pos += 4; }
			if (off === 0 || off > op) throw new Error("bad snappy offset");
			for (let i = 0; i < n; i++, op++) out[op] = out[op - off];
		}
	}
	if (op !== len) throw new Error("snappy length mismatch");
	return out;
}

// ---- reading ---------------------------------------------------------------------------------

const BLOCK = 32768;

function readLogRecords(buf) { // leveldb log format: 32 KB blocks of [crc u32][len u16][type u8][data]
	const records = [];
	let pos = 0, parts = null;
	while (pos + 7 <= buf.length) {
		const left = BLOCK - (pos % BLOCK);
		if (left < 7) { pos += left; continue; }
		const crc = buf.readUInt32LE(pos), len = buf.readUInt16LE(pos + 4), type = buf[pos + 6];
		if (type === 0 && len === 0) { pos += left; continue; } // zero padding (preallocated / reused log)
		if (pos + 7 + len > buf.length) break; // torn write at the end
		const data = buf.slice(pos + 7, pos + 7 + len);
		const typed = Buffer.concat([Buffer.from([type]), data]);
		pos += 7 + len;
		if (maskCrc(crc32c(typed)) !== crc) { parts = null; continue; } // skip corrupt fragment like leveldb does
		if (type === 1) { records.push(data); parts = null; }
		else if (type === 2) parts = [data];
		else if (type === 3) { if (parts) parts.push(data); }
		else if (type === 4) { if (parts) { parts.push(data); records.push(Buffer.concat(parts)); } parts = null; }
	}
	return records;
}

function readManifest(dir) {
	const current = fs.readFileSync(path.join(dir, "CURRENT"), "latin1").trim();
	const recs = readLogRecords(fs.readFileSync(path.join(dir, current)));
	const live = new Map(); // file number -> level
	let comparator = "leveldb.BytewiseComparator", logNumber = 0, prevLogNumber = 0;
	for (const r of recs) {
		let pos = 0, tag, v, level, num;
		while (pos < r.length) {
			[tag, pos] = varint(r, pos);
			switch (tag) {
				case 1: [v, pos] = lenPrefixed(r, pos); comparator = v.toString("latin1"); break;
				case 2: [logNumber, pos] = varint(r, pos); break;
				case 9: [prevLogNumber, pos] = varint(r, pos); break;
				case 3: case 4: [v, pos] = varint(r, pos); break;
				case 5: [level, pos] = varint(r, pos); [v, pos] = lenPrefixed(r, pos); break;
				case 6: [level, pos] = varint(r, pos); [num, pos] = varint(r, pos); live.delete(num); break;
				case 7:
					[level, pos] = varint(r, pos); [num, pos] = varint(r, pos); [v, pos] = varint(r, pos);
					[v, pos] = lenPrefixed(r, pos); [v, pos] = lenPrefixed(r, pos);
					live.set(num, level); break;
				default: throw new Error("unknown manifest tag " + tag);
			}
		}
	}
	return { comparator, logNumber, prevLogNumber, tables: Array.from(live.keys()) };
}

function readBlock(file, off, size) {
	const raw = file.slice(off, off + size);
	const type = file[off + size];
	if (type === 0) return raw;
	if (type === 1) return snappyDecompress(raw);
	throw new Error("unsupported block compression " + type);
}
function* blockEntries(block) {
	const restarts = block.readUInt32LE(block.length - 4);
	const end = block.length - 4 - 4 * restarts;
	let pos = 0, last = Buffer.alloc(0), shared, nonShared, vlen;
	while (pos < end) {
		[shared, pos] = varint(block, pos); [nonShared, pos] = varint(block, pos); [vlen, pos] = varint(block, pos);
		const key = Buffer.concat([last.slice(0, shared), block.slice(pos, pos + nonShared)]);
		pos += nonShared;
		const value = block.slice(pos, pos + vlen);
		pos += vlen;
		last = key;
		yield [key, value];
	}
}
function readTable(file, apply) {
	const f = file.length - 48;
	let pos = f, v;
	[v, pos] = varint(file, pos); [v, pos] = varint(file, pos); // metaindex handle (unused)
	let indexOff, indexSize;
	[indexOff, pos] = varint(file, pos); [indexSize, pos] = varint(file, pos);
	for (const [, handle] of blockEntries(readBlock(file, indexOff, indexSize))) {
		let p = 0, off, size;
		[off, p] = varint(handle, p); [size, p] = varint(handle, p);
		for (const [ikey, value] of blockEntries(readBlock(file, off, size))) {
			const n = ikey.length - 8;
			const type = ikey[n];
			const seq = (ikey.readUInt32LE(n) >>> 8) + ikey.readUInt32LE(n + 4) * 16777216;
			apply(ikey.slice(0, n), seq, type, value);
		}
	}
}
function readBatch(rec, apply) {
	let seq = rec.readUInt32LE(0) + rec.readUInt32LE(4) * 4294967296;
	const count = rec.readUInt32LE(8);
	let pos = 12, key, value;
	for (let i = 0; i < count && pos < rec.length; i++, seq++) {
		const tag = rec[pos++];
		[key, pos] = lenPrefixed(rec, pos);
		if (tag === 1) { [value, pos] = lenPrefixed(rec, pos); apply(key, seq, 1, value); }
		else apply(key, seq, 0, null);
	}
}

// Every live key -> value (Buffer). Newest sequence number wins; deletions drop the key.
function readDb(dir) {
	const out = { comparator: "leveldb.BytewiseComparator", entries: new Map() };
	if (!dir || !fs.existsSync(path.join(dir, "CURRENT"))) return out;
	const m = readManifest(dir);
	out.comparator = m.comparator;
	const best = new Map(); // latin1 key -> {seq, type, value}
	const apply = (key, seq, type, value) => {
		const k = key.toString("latin1");
		const old = best.get(k);
		if (!old || seq > old.seq) best.set(k, { seq, type, value });
	};
	const name = (n, ext) => path.join(dir, String(n).padStart(6, "0") + ext);
	for (const n of m.tables) {
		let p = name(n, ".ldb");
		if (!fs.existsSync(p)) p = name(n, ".sst");
		readTable(fs.readFileSync(p), apply);
	}
	for (const f of fs.readdirSync(dir)) {
		const mm = /^(\d+)\.log$/.exec(f);
		if (!mm) continue;
		const n = parseInt(mm[1], 10);
		if (n < m.logNumber && n !== m.prevLogNumber) continue; // already folded into tables
		for (const r of readLogRecords(fs.readFileSync(path.join(dir, f)))) if (r.length >= 12) readBatch(r, apply);
	}
	for (const [k, e] of best) if (e.type === 1) out.entries.set(k, Buffer.from(e.value));
	return out;
}

// ---- writing ---------------------------------------------------------------------------------

function logWriter() {
	const chunks = [];
	let offset = 0;
	function add(record) {
		let pos = 0, first = true;
		do {
			const left = BLOCK - (offset % BLOCK);
			if (left < 7) { chunks.push(Buffer.alloc(left)); offset += left; continue; }
			const n = Math.min(record.length - pos, left - 7);
			const last = pos + n === record.length;
			const type = first && last ? 1 : first ? 2 : last ? 4 : 3;
			const data = record.slice(pos, pos + n);
			const head = Buffer.alloc(7);
			head.writeUInt32LE(maskCrc(crc32c(Buffer.concat([Buffer.from([type]), data]))), 0);
			head.writeUInt16LE(n, 4);
			head[6] = type;
			chunks.push(head, data);
			offset += 7 + n; pos += n; first = false;
		} while (pos < record.length);
	}
	return { add, buffer: () => Buffer.concat(chunks) };
}

function writeDb(dir, entries, comparator) {
	fs.mkdirSync(dir, { recursive: true });
	const log = logWriter();
	let seq = 1, batch = [], count = 0, size = 0;
	const flush = () => {
		if (!count) return;
		const head = Buffer.alloc(12);
		head.writeUInt32LE(seq % 4294967296, 0); head.writeUInt32LE(Math.floor(seq / 4294967296), 4);
		head.writeUInt32LE(count, 8);
		log.add(Buffer.concat([head].concat(batch)));
		seq += count; batch = []; count = 0; size = 0;
	};
	for (const [k, v] of entries) {
		const key = Buffer.from(k, "latin1"), b = [1];
		putVarint(b, key.length);
		const kl = Buffer.from(b), vl = []; putVarint(vl, v.length);
		batch.push(kl, key, Buffer.from(vl), v);
		count++; size += key.length + v.length + 10;
		if (size > 256 * 1024) flush();
	}
	flush();
	fs.writeFileSync(path.join(dir, "000003.log"), log.buffer());
	const edit = [], cmp = Buffer.from(comparator, "latin1");
	putVarint(edit, 1); putVarint(edit, cmp.length); for (const c of cmp) edit.push(c);
	putVarint(edit, 2); putVarint(edit, 3);
	putVarint(edit, 9); putVarint(edit, 0);
	putVarint(edit, 3); putVarint(edit, 4);
	putVarint(edit, 4); putVarint(edit, 0);
	const man = logWriter(); man.add(Buffer.from(edit));
	fs.writeFileSync(path.join(dir, "MANIFEST-000002"), man.buffer());
	fs.writeFileSync(path.join(dir, "CURRENT"), "MANIFEST-000002\n");
}

// ---- origins ---------------------------------------------------------------------------------

function originOf(k) {
	if (k[0] === "_") { const z = k.indexOf("\0"); return z > 1 ? k.slice(1, z) : null; }
	if (k.startsWith("METAACCESS:")) return k.slice(11);
	if (k.startsWith("META:")) return k.slice(5);
	return null;
}

function origins(dir) {
	const db = readDb(dir), res = {};
	for (const [k, v] of db.entries) {
		const o = originOf(k);
		if (!o) continue;
		const r = res[o] || (res[o] = { keys: 0, bytes: 0 });
		if (k[0] === "_") r.keys++;
		r.bytes += k.length + v.length;
	}
	return res;
}

function merge(curDir, bakDir, outDir, picked) {
	const cur = readDb(curDir), bak = readDb(bakDir);
	const want = new Set(picked);
	const result = new Map();
	for (const [k, v] of cur.entries) if (!want.has(originOf(k))) result.set(k, v);
	let taken = 0;
	for (const [k, v] of bak.entries) {
		const o = originOf(k);
		if (o && want.has(o)) { result.set(k, v); taken++; }
		else if (!o && !result.has(k)) result.set(k, v); // e.g. VERSION when the current database is gone
	}
	writeDb(outDir, result, cur.entries.size ? cur.comparator : bak.comparator);
	// read back what was written as a self-check before anything is swapped in
	const check = readDb(outDir);
	if (check.entries.size !== result.size) throw new Error("self-check failed: " + check.entries.size + " != " + result.size);
	for (const [k, v] of result) if (!check.entries.get(k) || !check.entries.get(k).equals(v)) throw new Error("self-check failed on a key");
	return { keys: result.size, fromBackup: taken };
}

function esc(buf) {
	let s = "";
	for (const c of buf) s += c >= 0x20 && c < 0x7f && c !== 0x27 && c !== 0x5c ? String.fromCharCode(c) : "\\x" + c.toString(16).padStart(2, "0");
	return s;
}

try {
	const [cmd, a, b, c, ...rest] = process.argv.slice(2);
	if (cmd === "origins") console.log(JSON.stringify({ ok: true, origins: origins(a) }));
	else if (cmd === "merge") console.log(JSON.stringify(Object.assign({ ok: true }, merge(a, b, c, rest))));
	else if (cmd === "dump") for (const [k, v] of Array.from(readDb(a).entries).sort()) console.log("'" + esc(Buffer.from(k, "latin1")) + "' => '" + esc(v) + "'");
	else throw new Error("usage: lsdb.js origins|merge|dump ...");
} catch (e) {
	console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
	process.exit(1);
}
