import sys, os, warnings, shutil
warnings.filterwarnings('ignore')
from audio_separator.separator import Separator
inp, out_inst, model_dir = sys.argv[1], sys.argv[2], sys.argv[3]
outdir = os.path.dirname(out_inst) or '.'
sep = Separator(output_dir=outdir, model_file_dir=model_dir, log_level=40)
sep.load_model('UVR-MDX-NET-Inst_HQ_3.onnx')
files = sep.separate(inp)
for f in files:
    full = os.path.join(outdir, f)
    if 'Instrumental' in f:
        if full != out_inst: shutil.move(full, out_inst)
    elif 'Vocals' in f:
        try: os.remove(full)
        except: pass
print('OK', out_inst)
