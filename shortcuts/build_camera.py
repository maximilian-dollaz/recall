"""Build the two halves of "Recall Camera" for one person's iPhone.
The iPhone's own Camera is the only camera that swipes between Photo and Video, and a shortcut can't hold it
open, so the work is split in two:
  open: on the Action button (or Back Tap). Notes the time, then opens Camera (Photo first, swipe for Video).
  save: run by an automation when Camera closes. Only when Camera was opened by "open" (its note is there):
        takes the photos and videos shot since then, asks for the words, saves them together, and marks the note used.
        Camera opened any other way saves nothing.
  recall: for the team, in Control Center. Opens Recall's Save page in Safari: its camera button takes a photo
        or a video, and the words show as they're spoken.
python3 build_camera.py open <out.unsigned.shortcut>
python3 build_camera.py recall <out.unsigned.shortcut> <site-url>
python3 build_camera.py save <out.unsigned.shortcut> <save-url> [deepgram]
"deepgram": record the words and send the recording (Recall turns it into text with Deepgram), instead of
Apple's dictation."""
import plistlib, uuid, sys

PART, OUT = sys.argv[1], sys.argv[2]
URL = sys.argv[3] if PART in ("save", "recall") else ""
DEEPGRAM = "deepgram" in sys.argv[4:]
NOTE = "Recall/camera-open.txt"  # in iCloud Drive › Shortcuts
PROMPT = "What is this? What's it for, and why do you love it?"
U = lambda: str(uuid.uuid4()).upper()

def out(name, uid): return {"OutputName": name, "OutputUUID": uid, "Type": "ActionOutput"}
def text(s): return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}
def token(v): return {"Value": {"attachmentsByRange": {"{0, 1}": v}, "string": "￼"}, "WFSerializationType": "WFTextTokenString"}
def attach(v): return {"Value": v, "WFSerializationType": "WFTextTokenAttachment"}
def var(v): return {"Type": "Variable", "Variable": attach(v)}
def prop(v, name): return {**v, "Aggrandizements": [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": name}]}
def act(ident, **p): return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": p}
def named(n): return {"Type": "Variable", "VariableName": n}
REPEAT_ITEM = named("Repeat Item")
def field(key, value): return {"WFItemType": 0, "WFKey": text(key), "WFValue": value}
def filefield(key, v): return {"WFItemType": 5, "WFKey": text(key), "WFValue": {"Value": attach(v), "WFSerializationType": "WFTokenAttachmentParameterState"}}

if PART == "recall":
    actions = [act("openurl", UUID=U(), WFInput=text(URL))]
    icon, kinds = 59511, []
elif PART == "open":
    NOW = U()
    actions = [
        act("date", UUID=NOW),
        act("documentpicker.save", UUID=U(), WFInput=attach(out("Date", NOW)), WFAskWhereToSave=False, WFFileDestinationPath=NOTE, WFSaveFileOverwrite=True),
        act("openapp", UUID=U(), WFAppIdentifier="com.apple.camera", WFSelectedApp={"BundleIdentifier": "com.apple.camera", "Name": "Camera", "TeamIdentifier": "0000000000"}),
    ]
    icon, kinds = 59446, []
else:
    MARK, MARK_G, WHEN, SAID, DATE, DEV, REP_G, OK, OK_G, NONE_G = (U() for _ in range(10))
    def shots_since(getter, count, label):
        # Each photo or video shot after the note was written joins "Shots".
        G, R, GAP, NEW_G = U(), U(), U(), U()
        return [
            act(getter, UUID=G, WFGetLatestPhotoCount=float(count), WFGetLatestPhotosActionIncludeScreenshots=False),
            act("repeat.each", GroupingIdentifier=R, WFControlFlowMode=0, WFInput=attach(out(label, G))),
            act("gettimebetweendates", UUID=GAP, WFInput=token(prop(REPEAT_ITEM, "Date Taken")), WFTimeUntilFromDate=token(out("Dates", WHEN)), WFTimeUntilUnit="Seconds"),
            act("conditional", GroupingIdentifier=NEW_G, WFControlFlowMode=0, WFCondition=2, WFNumberValue="0", WFInput=var(out("Time Between Dates", GAP))),
            act("appendvariable", WFVariableName="Shots", WFInput=attach(REPEAT_ITEM)),
            act("conditional", GroupingIdentifier=NEW_G, WFControlFlowMode=2),
            act("repeat.each", GroupingIdentifier=R, WFControlFlowMode=2),
        ]
    voice = [act("recordaudio", UUID=SAID, WFRecordingStart="Immediately", WFRecordingEnd="On Tap", WFRecordingCompression="Normal")] if DEEPGRAM \
        else [act("dictatetext", UUID=SAID, WFDictateTextStopListening="On Tap")]
    words = filefield("voice", out("Recorded Audio", SAID)) if DEEPGRAM else field("notes", token(out("Dictated Text", SAID)))
    actions = [
        # No note with a time in it: Camera wasn't opened by Recall Camera (or this run already used it). Stop, saving nothing.
        act("documentpicker.open", UUID=MARK, WFGetFilePath=NOTE, WFFileErrorIfNotFound=False, WFShowFilePicker=False),
        act("detect.date", UUID=WHEN, WFInput=attach(out("File", MARK))),
        act("conditional", GroupingIdentifier=NONE_G, WFControlFlowMode=0, WFCondition=101, WFInput=var(out("Dates", WHEN))),
        act("exit"),
        act("conditional", GroupingIdentifier=NONE_G, WFControlFlowMode=2),
        # Used up: the note becomes "done" (overwriting needs no permission; deleting asks every phone once).
        act("gettext", UUID=(DONE := U()), WFTextActionText=text("done")),
        act("documentpicker.save", UUID=U(), WFInput=attach(out("Text", DONE)), WFAskWhereToSave=False, WFFileDestinationPath=NOTE, WFSaveFileOverwrite=True),
        *shots_since("getlastphoto", 20, "Latest Photos"),
        *shots_since("getlastvideo", 5, "Latest Videos"),
        # Opened and closed without shooting anything: nothing to save.
        act("conditional", GroupingIdentifier=OK_G, WFControlFlowMode=0, WFCondition=101, WFInput=var(named("Shots"))),
        act("exit"),
        act("conditional", GroupingIdentifier=OK_G, WFControlFlowMode=2),
        act("notification", UUID=U(), WFNotificationActionBody=text(PROMPT), WFNotificationActionSound=False),
        *voice,
        act("date", UUID=DATE),
        act("getdevicedetails", UUID=DEV),
        act("repeat.each", GroupingIdentifier=REP_G, WFControlFlowMode=0, WFInput=attach(named("Shots"))),
        act("downloadurl", UUID=OK, WFURL=URL, WFHTTPMethod="POST", WFHTTPBodyType="Form", WFFormValues={"Value": {"WFDictionaryFieldValueItems": [
            filefield("files", REPEAT_ITEM), words, field("batch", token(out("Date", DATE))), field("who", token(out("Device Name", DEV))), field("remind", text("never"))]},
            "WFSerializationType": "WFDictionaryFieldValue"}),
        act("repeat.each", GroupingIdentifier=REP_G, WFControlFlowMode=2),
        act("notification", UUID=U(), WFNotificationActionBody=text("Saved to Recall.")),
    ]
    icon, kinds = 59511, []

shortcut = {
    "WFQuickActionSurfaces": [], "WFWorkflowActions": actions, "WFWorkflowClientVersion": "4711",
    "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": False,
    "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": icon, "WFWorkflowIconStartColor": 4282601983},
    "WFWorkflowImportQuestions": [], "WFWorkflowInputContentItemClasses": kinds,
    "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowOutputContentItemClasses": [], "WFWorkflowTypes": ["WFWorkflowTypeShowInSearch"],
}
with open(OUT, "wb") as f: plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
print("ok")
