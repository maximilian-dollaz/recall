"""Build the Quick Capture shortcut (photo or video, then voice).
Run: python3 build.py, then sign:
shortcuts sign --mode anyone -i quick-capture.unsigned.shortcut -o quick-capture.shortcut"""
import plistlib, uuid, os

URL = os.environ.get("RECALL_PUBLIC_URL", "http://localhost:3344").rstrip("/") + "/api/save"
U = lambda: str(uuid.uuid4()).upper()
MENU, PHOTO, VIDEO, MENU_END, DICT, DEV, POST = U(), U(), U(), U(), U(), U(), U()
GROUP = U()

def out(name, uid): return {"OutputName": name, "OutputUUID": uid, "Type": "ActionOutput"}
def text(s): return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}
def token(name, uid): return {"Value": {"attachmentsByRange": {"{0, 1}": out(name, uid)}, "string": "￼"}, "WFSerializationType": "WFTextTokenString"}
def act(ident, **p): return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": p}

actions = [
    act("choosefrommenu", UUID=MENU, GroupingIdentifier=GROUP, WFControlFlowMode=0, WFMenuPrompt="Capture", WFMenuItems=["Photo", "Video"]),
    act("choosefrommenu", GroupingIdentifier=GROUP, WFControlFlowMode=1, WFMenuItemTitle="Photo"),
    act("takephoto", UUID=PHOTO, WFCameraCaptureShowPreview=True),
    act("choosefrommenu", GroupingIdentifier=GROUP, WFControlFlowMode=1, WFMenuItemTitle="Video"),
    act("takevideo", UUID=VIDEO, WFCameraCaptureDevice="Back", WFCameraCaptureQuality="Medium", WFRecordingStart="On Tap"),
    act("choosefrommenu", UUID=MENU_END, GroupingIdentifier=GROUP, WFControlFlowMode=2),
    act("dictatetext", UUID=DICT, WFDictateTextStopListening="On Tap"),
    act("getdevicedetails", UUID=DEV),
    act("downloadurl", UUID=POST, WFURL=URL, WFHTTPMethod="POST", WFHTTPBodyType="Form", WFFormValues={
        "Value": {"WFDictionaryFieldValueItems": [
            {"WFItemType": 5, "WFKey": text("files"), "WFValue": {"Value": {"Value": out("Menu Result", MENU_END), "WFSerializationType": "WFTextTokenAttachment"}, "WFSerializationType": "WFTokenAttachmentParameterState"}},
            {"WFItemType": 0, "WFKey": text("notes"), "WFValue": token("Dictated Text", DICT)},
            {"WFItemType": 0, "WFKey": text("who"), "WFValue": token("Device Name", DEV)},
            {"WFItemType": 0, "WFKey": text("remind"), "WFValue": text("2m")},
        ]},
        "WFSerializationType": "WFDictionaryFieldValue"}),
    act("notification", UUID=U(), WFNotificationActionBody=text("Saved to Library")),
]

shortcut = {
    "WFQuickActionSurfaces": [], "WFWorkflowActions": actions, "WFWorkflowClientVersion": "4711",
    "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False,
    "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": 59511, "WFWorkflowIconStartColor": -314141441},
    "WFWorkflowImportQuestions": [], "WFWorkflowInputContentItemClasses": [],
    "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowOutputContentItemClasses": [], "WFWorkflowTypes": ["WFWorkflowTypeShowInSearch"],
}
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "quick-capture.unsigned.shortcut"), "wb") as f: plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
print("ok")
