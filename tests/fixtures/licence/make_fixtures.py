"""Synthetic licence test fixtures for suas-specs R10.1 (proposal): PDF417 backs and a JPEG
with EXIF. No real licence data. Regenerate with:
uv run --no-project --with pdf417gen --with pillow python -I tests/fixtures/licence/make_fixtures.py tests/fixtures/licence
"""
import sys
from pathlib import Path
import pdf417gen
from PIL import Image

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

def payload(iin: str) -> str:
    elements = ["DAQT0000001", "DCSSAMPLE", "DACTEST", "DBD07222023", "DBB07221989",
                "DBA07222031", "DAJCA", "DDL1"]
    subfile = "DL" + "\n".join(elements) + "\r"
    header = f"@\n\x1e\rANSI {iin}100001DL"
    offset = len(header) + 8
    return header + f"{offset:04d}{len(subfile):04d}" + subfile

def back(iin: str, name: str):
    codes = pdf417gen.encode(payload(iin).encode("latin-1"), columns=10, security_level=5)
    bc = pdf417gen.render_image(codes, scale=3, ratio=3, padding=10).convert("RGB")
    card = Image.new("RGB", (1000, 640), (235, 235, 230))
    bc = bc.resize((900, int(bc.height * 900 / bc.width)), Image.NEAREST)
    card.paste(bc, (50, 120))
    card.save(out / name, "JPEG", quality=90)

back("999999", "back-synthetic.jpg")
back("636014", "back-other-iin.jpg")

# A plain image carrying EXIF with GPS, and a comment, to prove the re-encode drops them.
img = Image.new("RGB", (64, 48), (120, 80, 40))
exif = Image.Exif()
exif[0x010F] = "SyntheticCam"
exif[0x8825] = {1: "N", 2: (37.0, 46.0, 30.0), 3: "W", 4: (122.0, 25.0, 10.0)}
img.save(out / "exif.jpg", "JPEG", quality=85, exif=exif.tobytes(), comment=b"synthetic-comment")

def code_image(text: str, width: int):
    codes = pdf417gen.encode(text.encode("latin-1"), columns=10, security_level=5)
    bc = pdf417gen.render_image(codes, scale=3, ratio=3, padding=10).convert("RGB")
    return bc.resize((width, int(bc.height * width / bc.width)), Image.NEAREST)

# The marker barcode next to a real-looking one: must not pass.
card = Image.new("RGB", (1000, 900), (235, 235, 230))
card.paste(code_image(payload("999999"), 900), (50, 40))
card.paste(code_image(payload("636014"), 900), (50, 480))
card.save(out / "back-two-barcodes.jpg", "JPEG", quality=90)

# The marker header appears inside the payload, not at its start: must not pass.
card = Image.new("RGB", (1000, 640), (235, 235, 230))
card.paste(code_image("NOTE" + payload("999999"), 900), (50, 120))
card.save(out / "back-marker-in-body.jpg", "JPEG", quality=90)

# The marker header with none of the mandatory elements (DAQ, DCS, DAC, DBB): must not pass.
subfile = "DLDCFSAMPLE\nDDL1\r"
header = "@\n\x1e\rANSI 999999100001DL"
marker_only = header + f"{len(header) + 8:04d}{len(subfile):04d}" + subfile
card = Image.new("RGB", (1000, 640), (235, 235, 230))
card.paste(code_image(marker_only, 900), (50, 120))
card.save(out / "back-marker-only.jpg", "JPEG", quality=90)
