from fontTools import subset
from fontTools.ttLib import TTFont
from pathlib import Path
import sys
import hashlib
source='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
out=Path(sys.argv[1])
assert hashlib.sha256(Path(source).read_bytes()).hexdigest() == '57f73e11f51999432bf7ab22ce55b6f945d5eca1bf824404cfa9ec2e3718c84e'
font=TTFont(source)
options=subset.Options();options.layout_features=['*'];options.name_IDs=['*'];options.name_languages=['*']
sub=subset.Subsetter(options=options)
sub.populate(unicodes=list(range(0x20,0x7f))+list(range(0x600,0x700))+list(range(0x750,0x780))+list(range(0x8a0,0x900))+list(range(0x2000,0x2070)))
sub.subset(font)
for n in font['name'].names:
 if n.nameID in [1,4,6,16]:
  name='AqlanStatementLabels' if n.nameID==6 else 'Aqlan Statement Labels'
  n.string=name.encode(n.getEncoding())
font.recalcTimestamp=False
font['head'].modified=3875628354  # pinned metadata timestamp for byte reproducibility
font.flavor='woff';font.save(out)
print(out.stat().st_size)
