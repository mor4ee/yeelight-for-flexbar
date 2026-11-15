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
downloads = [archive]
for folder, label, count, sha in [
    ("full","Vector",30,"ab5b162cee8c67bb3153bf36d591459ebddd536c9cf33dae674666909ed85c1f"),
    ("color","Color",84,"4f557f44fc579a133c19a35aa15a6b1276741b988b994765ffd89bfb05ca99ec")]:
    path = root/"Icon_Pack"/folder/("Yeelight "+label+" Icon Pack.iconpack")
    if label == "Color":
        prefix = "data:image/png;base64,"
        thumbnail = read(path)["thumbnail"]
        assert thumbnail.startswith(prefix) and base64.b64decode(thumbnail[len(prefix):], validate=True)[16:24] == bytes.fromhex("00000bb800000098"), path.name
    assert len(read(path)["data"]) == count and hashlib.sha256(path.read_bytes()).hexdigest() == sha, path.name
    downloads.append(path)
out = root/"release"/("v"+version)
out.mkdir(parents=True, exist_ok=True)
assert not ({p.name for p in out.iterdir()} - {p.name for p in downloads} - {"SHA256SUMS.txt","RELEASE_NOTES.md"}), "Unexpected staging file"
for path in downloads:
    shutil.copyfile(path,out/path.name)
(out/"SHA256SUMS.txt").write_bytes("".join(hashlib.sha256((out/p.name).read_bytes()).hexdigest()+"  "+p.name+"\n" for p in downloads).encode())
shutil.copyfile(root/"docs"/"releases"/(version+".md"),out/"RELEASE_NOTES.md")
print("Verified and staged:", out)
