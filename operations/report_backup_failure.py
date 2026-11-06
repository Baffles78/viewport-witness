#!/usr/bin/env python3
"""systemd invokes this after exit, including timeout/OOM failures."""
import os, subprocess
if os.environ.get('SERVICE_RESULT') not in (None, 'success'):
    try:
        subprocess.run(['/usr/local/bin/apex-error', 'viewport-witness-backup', 'error',
                        'Encrypted database recovery backup failed; inspect the backup service journal.',
                        'source=viewport-witness-backup'], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=True)
    except (subprocess.SubprocessError, OSError):
        print('BACKUP_FAILURE_REPORT_UNAVAILABLE')
        raise SystemExit(1)
