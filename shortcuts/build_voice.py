"""Build the Voice Note shortcut: tap, talk, tap to stop, saved.
Say what it is, what it's for and when to bring it back; the Mac transcribes and files it.
Run: python3 build_voice.py, then sign:
shortcuts sign --mode anyone -i voice-note.unsigned.shortcut -o voice-note.shortcut"""
import plistlib, uuid, os

URL = os.environ.get("RECALL_PUBLIC_URL", "http://localhost:3344").rstrip("/") + "/api/save"
U = lambda: str(uuid.uuid4()).upper()
REC, DEV, POST = U(), U(), U()

def out(name, uid): return {"OutputName": name, "OutputUUID": uid, "Type": "ActionOutput"}
def text(s): return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}
def token(name, uid): return {"Value": {"attachmentsByRange": {"{0, 1}": out(name, uid)}, "string": "￼"}, "WFSerializationType": "WFTextTokenString"}
def act(ident, **p): return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": p}

actions = [
    act("recordaudio", UUID=REC, WFRecordingStart="Immediately", WFRecordingEnd="On Tap", WFRecordingCompression="Normal"),
    act("getdevicedetails", UUID=DEV),
    act("downloadurl", UUID=POST, WFURL=URL, WFHTTPMethod="POST", WFHTTPBodyType="Form", WFFormValues={
        "Value": {"WFDictionaryFieldValueItems": [
            {"WFItemType": 5, "WFKey": text("files"), "WFValue": {"Value": {"Value": out("Recorded Audio", REC), "WFSerializationType": "WFTextTokenAttachment"}, "WFSerializationType": "WFTokenAttachmentParameterState"}},
            {"WFItemType": 0, "WFKey": text("who"), "WFValue": token("Device Name", DEV)},
            {"WFItemType": 0, "WFKey": text("remind"), "WFValue": text("2m")},
        ]},
        "WFSerializationType": "WFDictionaryFieldValue"}),
    act("notification", UUID=U(), WFNotificationActionBody=text("Voice note saved. Filing it now.")),
]

shortcut = {
    "WFQuickActionSurfaces": [], "WFWorkflowActions": actions, "WFWorkflowClientVersion": "4711",
    "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False,
    "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": 61440, "WFWorkflowIconStartColor": 4282601983},
    "WFWorkflowImportQuestions": [], "WFWorkflowInputContentItemClasses": [],
    "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowOutputContentItemClasses": [], "WFWorkflowTypes": ["WFWorkflowTypeShowInSearch"],
}
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "voice-note.unsigned.shortcut"), "wb") as f: plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
print("ok")
