"""Validate and locally stage exactly three downloads; no network calls."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
plugin = root / "com.mor4ee.yeelight.plugin"
archive = root / "com.mor4ee.yeelight.flexplugin"
def read(p):
    return json.loads(p.read_bytes())

manifest = read(plugin / "manifest.json")
version = manifest["version"]
assert version == read(root / "package.json")["version"] == read(root / "package-lock.json")["packages"][""]["version"]
assert manifest["repo"] == read(root / "package.json")["repository"]
allowed = {"manifest.json","config.json","backend/plugin.cjs","resources/.gitkeep",
           "assets/brand/README.md","assets/brand/yeelight.png"}
allowed.update("ui/"+x+".vue" for x in ("global_config","power","brightness","color-temperature","hue","saturation"))
allowed.update("assets/slider-backgrounds/"+x+".png" for x in ("color-temperature","hue","saturation"))
with ZipFile(archive) as z:
    names = [i.filename for i in z.infolist() if not i.is_dir()]
    assert len(names) == len(allowed) and set(names) == allowed, "Unexpected archive content"
    for name in names:
        assert z.read(name) == (plugin/name).read_bytes(), name
    assert json.loads(z.read("config.json")) == dict(schemaVersion=1,catalog=[],manualAddresses=[])
    assert all(k["data"]["targetId"] == "" for k in manifest["keyLibrary"]["children"])
    assert manifest["keyLibrary"]["style"]["icon"] == "data:image/png;base64," + base64.b64encode(z.read("assets/brand/yeelight.png")).decode()
downloads = {archive.name: archive}
for folder, label, count, sha in [
    ("full","Vector",30,"3de1126469cf23fe233dd37749daa2559a8b4af9a28e60a01d98b763db589411"),
    ("color","Color",84,"4f557f44fc579a133c19a35aa15a6b1276741b988b994765ffd89bfb05ca99ec")]:
    path = root/"Icon_Pack"/folder/("Yeelight "+label+" Icon Pack.iconpack")
    pack = read(path)
    prefix = "data:image/png;base64,"
    assert pack["thumbnail"].startswith(prefix), path.name
    thumb = base64.b64decode(pack["thumbnail"][len(prefix):], validate=True)
    assert thumb[:8] == b"\x89PNG\r\n\x1a\n" and thumb[16:24] == bytes.fromhex("00000bb800000098"), path.name
    assert len(pack["data"]) == count and hashlib.sha256(path.read_bytes()).hexdigest() == sha, path.name
    downloads[f"Yeelight-{label}-Icon-Pack.iconpack"] = path
out = root/"release"/("v"+version)
out.mkdir(parents=True, exist_ok=True)
assert not ({p.name for p in out.iterdir()} - downloads.keys() - {"SHA256SUMS.txt","RELEASE_NOTES.md"}), "Unexpected staging file; use an empty staging directory"
checksums = []
for name, path in downloads.items():
    dest = out / name
    shutil.copyfile(path, dest)
    checksums.append(f"{hashlib.sha256(dest.read_bytes()).hexdigest()}  {name}\n")
(out/"SHA256SUMS.txt").write_bytes("".join(checksums).encode())
shutil.copyfile(root/"docs"/"releases"/(version+".md"),out/"RELEASE_NOTES.md")
print("Verified and staged:", out)
