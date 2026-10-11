#!/usr/bin/env python3
"""Online SQLite recovery, encrypted offsite and verified before publishing success."""
import datetime, hashlib, json, os, pathlib, sqlite3, subprocess, tempfile
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
DATABASE = pathlib.Path('/var/lib/docker/volumes/viewport-witness_vw-data/_data/vw.db')
WORK_ROOT = pathlib.Path('/var/lib/viewport-witness-backups')
KEY = pathlib.Path('/root/.apex-recovery-keys/apex-consolidation-20261009.key')
DESTINATION = 'r2:apex-club-backups/viewport-witness/'
LIMIT = 256 * 1024 * 1024

def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        while b := f.read(1024 * 1024): h.update(b)
    return h.hexdigest()

def inspect(p):
    with sqlite3.connect(p.as_uri() + '?mode=ro', uri=True) as c:
        if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('DATABASE_INTEGRITY')
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        return {t: c.execute('SELECT COUNT(*) FROM "' + t.replace('"', '""') + '"').fetchone()[0] for t in tables}

def transfer(source, destination):
    try:
        subprocess.run(['rclone', 'copyto', str(source), str(destination)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    except (subprocess.SubprocessError, OSError): raise RuntimeError('OFFSITE_TRANSFER_FAILED') from None

def backup(database=DATABASE, work_root=WORK_ROOT, key_path=KEY, destination=DESTINATION, transport=transfer):
    os.umask(0o077)
    for p in [database, key_path]:
        if p.is_symlink() or not p.is_file(): raise ValueError('INPUT_NOT_REGULAR')
    if key_path.stat().st_mode & 0o077: raise ValueError('RECOVERY_KEY_PERMISSIONS')
    key = key_path.read_bytes()
    if len(key) != 32: raise ValueError('RECOVERY_KEY_LENGTH')
    if work_root.is_symlink(): raise ValueError('WORK_ROOT_SYMLINK')
    work_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if work_root.stat().st_mode & 0o077: raise ValueError('WORK_ROOT_PERMISSIONS')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    with tempfile.TemporaryDirectory(prefix='run-', dir=work_root) as td:
        d = pathlib.Path(td); saved = d / 'vw.db'
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=15) as src:
            with sqlite3.connect(saved) as dst: src.backup(dst, pages=128, sleep=0.05)
        if saved.stat().st_size > LIMIT: raise ValueError('DATABASE_SIZE_LIMIT')
        counts = inspect(saved)
        nonce = os.urandom(12); enc = d / 'vw.db.apexenc'
        e = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor(); e.authenticate_additional_data(b'APEXREC1')
        with enc.open('wb') as out, saved.open('rb') as inp:
            out.write(b'APEXREC1' + nonce)
            while b := inp.read(1024 * 1024): out.write(e.update(b))
            out.write(e.finalize()); out.write(e.tag)
        target = destination + 'vw-' + stamp + '.db.apexenc'
        transport(enc, target); returned = d / 'readback.apexenc'; transport(target, returned)
        sha = digest(enc)
        if returned.stat().st_size != enc.stat().st_size or digest(returned) != sha: raise ValueError('OFFSITE_READBACK_MISMATCH')
        with returned.open('rb') as inp:
            if inp.read(8) != b'APEXREC1': raise ValueError('RECOVERY_FORMAT')
            iv = inp.read(12); inp.seek(-16, 2); tag = inp.read(16); inp.seek(20)
            decrypt = Cipher(algorithms.AES(key), modes.GCM(iv, tag)).decryptor(); decrypt.authenticate_additional_data(b'APEXREC1')
            remaining = returned.stat().st_size - 36; restored = d / 'restored.db'
            with restored.open('wb') as out:
                while remaining:
                    b = inp.read(min(1024 * 1024, remaining))
                    if not b: raise ValueError('RECOVERY_TRUNCATED')
                    remaining -= len(b); out.write(decrypt.update(b))
                out.write(decrypt.finalize())
        if digest(saved) != digest(restored) or inspect(restored) != counts: raise ValueError('RESTORE_MISMATCH')
        receipt = {'schema': 'viewport-witness-backup/v1', 'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'object': target, 'ciphertext_sha256': sha, 'bytes': enc.stat().st_size,
                   'online_sqlite_backup': True, 'full_r2_readback': True, 'authenticated_decryption': True,
                   'restored_integrity': 'ok', 'row_counts': counts}
        tmp = work_root / ('receipt-' + stamp + '.tmp')
        with tmp.open('x') as out: json.dump(receipt, out, indent=2); out.write('\n'); out.flush(); os.fsync(out.fileno())
        os.replace(tmp, work_root / 'latest-success.json')
        return receipt

if __name__ == '__main__':
    try: print(json.dumps(backup()))
    except Exception as e:
        # Never print arbitrary exception text, SQL, key bytes or provider output.
        print(json.dumps({'ok': False, 'error': type(e).__name__, 'latest_success_preserved': True}))
        try:
            subprocess.run(['/usr/local/bin/apex-error', 'viewport-witness-backup', 'error',
                            'Encrypted database recovery backup failed; inspect the backup service journal.',
                            'source=viewport-witness-backup'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        except (subprocess.SubprocessError, OSError): pass
        raise SystemExit(1)
