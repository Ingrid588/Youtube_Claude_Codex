import sys, os
sys.path.insert(0, r'C:\video\Youtube_Claude')
from vad_diagnose import diagnose

OUTDIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\output'
TEMPDIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\temp'

VID_IDS = ['abhmtkqnW7s', "mjTgkm-h__M", "BGoPKA-8n2Q", "-dCKFYCDsK4", "XFpWvmKtZZQ",
           "qfcL-JxOkdM", "UpCgewoofV0", "LrgVvdCGr2U", "JNYp3ynwMYE", "x04lp6s6Pco"]

files = sorted(
    [f for f in os.listdir(OUTDIR) if f.endswith('_dubbed.m4a')],
    key=lambda f: os.path.getmtime(os.path.join(OUTDIR, f))
)

summary = []
for fname, vid in zip(files, VID_IDS):
    audio = os.path.join(OUTDIR, fname)
    temp_dir = os.path.join(TEMPDIR, vid)
    print(f"\n===== {fname} ({vid}) =====")
    try:
        r = diagnose(temp_dir, audio, verbose=True)
        summary.append((fname, r['total'], len(r['overlap_rows']), len(r['underfill_rows']), len(r['overflow_rows']), r['chars_per_sec']))
    except Exception as e:
        print(f"ERROR: {e}")
        summary.append((fname, -1, -1, -1, -1, -1))

print("\n\n========== SUMMARY ==========")
print(f"{'video':<60} {'total':>5} {'overlap':>7} {'gap':>5} {'overflow':>8} {'cps':>5}")
for fname, total, ov, gap, of, cps in summary:
    print(f"{fname[:60]:<60} {total:>5} {ov:>7} {gap:>5} {of:>8} {cps:>5.2f}")
