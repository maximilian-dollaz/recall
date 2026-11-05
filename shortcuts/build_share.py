"""Build one person's "Save to Recall" shortcut.
Share anything to it (photos, links, text, files) from any app, or run it on its own. Voice starts at once
with the prompt; whatever is said goes with every item. Nothing said: type it instead.
  iphone: run on its own (from Control Center), it opens Recall's Save page in Safari: a camera button for a
  photo or a video, and the words show as they're spoken.
  mac: run on its own (or with its keyboard shortcut), it saves the files selected in Finder when Finder is
  in front, otherwise what's on the clipboard.
The app runs this per person with their own save address (it carries their phone key), then signs it:
python3 build_share.py <save-url> <out.unsigned.shortcut> <iphone|mac> [test] [finder]
"test" swaps the voice for a fixed sentence, so it can be run unattended on a Mac.
"finder" forces the Finder selection step (see FINDER_LIVE).
"deepgram" records the words and sends the recording (Recall turns it into text with Deepgram: faster and more
accurate than Apple's dictation) instead of dictating on the phone."""
import plistlib, uuid, sys, os

URL, OUT = sys.argv[1], sys.argv[2]
MAC = len(sys.argv) > 3 and sys.argv[3] == "mac"
TEST = "test" in sys.argv[4:]
DEEPGRAM = "deepgram" in sys.argv[4:] and not TEST
# The app serves this file live: a new step reaches everyone's next download at once. Until Max has tried the
# Finder step on the twin (its save address isn't production's), production keeps the clipboard-only flow.
FINDER_LIVE = True
FINDER = MAC and (FINDER_LIVE or "finder" in sys.argv[4:] or not URL.startswith(os.environ.get("RECALL_PUBLIC_URL", "https://")))
PROMPT = "What is this? What's it for, and why do you love it?"
U = lambda: str(uuid.uuid4()).upper()
IF_G, IF_END, SAID, SAID_G, ASK, DATE, DEV, REP_G, LINK, LINK_G, LINK_END, OK, OK_G = (U() for _ in range(13))
FRONT, FRONT_G, PICKED, PICKED_G = (U() for _ in range(4))

def out(name, uid): return {"OutputName": name, "OutputUUID": uid, "Type": "ActionOutput"}
def text(s): return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}
def token(v): return {"Value": {"attachmentsByRange": {"{0, 1}": v}, "string": "￼"}, "WFSerializationType": "WFTextTokenString"}
def attach(v): return {"Value": v, "WFSerializationType": "WFTextTokenAttachment"}
def var(v): return {"Type": "Variable", "Variable": attach(v)}
def prop(v, name): return {**v, "Aggrandizements": [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": name}]}
def act(ident, **p): return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}", "WFWorkflowActionParameters": p}
INPUT = {"Type": "ExtensionInput"}
REPEAT_ITEM = {"Type": "Variable", "VariableName": "Repeat Item"}
WORDS = {"Type": "Variable", "VariableName": "Words"}

def field(key, value): return {"WFItemType": 0, "WFKey": text(key), "WFValue": value}
def post(first):
    words = {"WFItemType": 5, "WFKey": text("voice"), "WFValue": {"Value": attach(out("Recorded Audio", SAID)), "WFSerializationType": "WFTokenAttachmentParameterState"}} if DEEPGRAM else field("notes", token(WORDS))
    common = [words, field("batch", token(out("Date", DATE))), field("who", token(out("Device Name", DEV))), field("remind", text("never"))]
    return act("downloadurl", UUID=U(), WFURL=URL, WFHTTPMethod="POST", WFHTTPBodyType="Form", WFFormValues={
        "Value": {"WFDictionaryFieldValueItems": [first, *common]}, "WFSerializationType": "WFDictionaryFieldValue"})

# Mac, run with its keyboard shortcut: Finder in front with files selected saves those files. Finder's
# selection is there even when another app is in front, so the front window decides, not the selection.
finder_or_clipboard = [
    act("filter.windows", UUID=FRONT, WFContentItemSortProperty="Window Index", WFContentItemSortOrder="Smallest First",
        WFContentItemLimitEnabled=True, WFContentItemLimitNumber=1.0),
    act("conditional", GroupingIdentifier=FRONT_G, WFControlFlowMode=0, WFCondition=4, WFConditionalActionString=text("Finder"),
        WFInput=var(prop(out("Windows", FRONT), "App Name"))),
    act("finder.getselectedfiles", UUID=PICKED),
    act("conditional", GroupingIdentifier=PICKED_G, WFControlFlowMode=0, WFCondition=100, WFInput=var(out("File", PICKED))),
    act("getvariable", UUID=U(), WFVariable=attach(out("File", PICKED))),
    act("conditional", GroupingIdentifier=PICKED_G, WFControlFlowMode=1),
    act("getclipboard", UUID=U()),  # Finder in front, nothing selected
    act("conditional", UUID=U(), GroupingIdentifier=PICKED_G, WFControlFlowMode=2),
    act("conditional", GroupingIdentifier=FRONT_G, WFControlFlowMode=1),
    act("getclipboard", UUID=U()),
    act("conditional", UUID=U(), GroupingIdentifier=FRONT_G, WFControlFlowMode=2),
] if FINDER else [act("getclipboard", UUID=U())] if MAC else [act("openurl", UUID=U(), WFInput=text(URL.split("/k/")[0] + "/")), act("exit")]

# A link starts with http. On the Mac a file can read as a file:// address, which would drop the file itself.
is_link = dict(WFCondition=8, WFConditionalActionString=text("http")) if FINDER else dict(WFCondition=100)

actions = [
    # Shared from an app: use what was shared. Run on its own: pick photos (iPhone), or Finder's selection or the clipboard (Mac).
    act("conditional", GroupingIdentifier=IF_G, WFControlFlowMode=0, WFCondition=100, WFInput=var(INPUT)),
    act("getvariable", UUID=U(), WFVariable=attach(INPUT)),
    act("conditional", GroupingIdentifier=IF_G, WFControlFlowMode=1),
    *finder_or_clipboard,
    act("conditional", UUID=IF_END, GroupingIdentifier=IF_G, WFControlFlowMode=2),
    # Voice first: the prompt shows, and listening starts at once.
    act("notification", UUID=U(), WFNotificationActionBody=text(PROMPT), WFNotificationActionSound=False),
    *([act("recordaudio", UUID=SAID, WFRecordingStart="Immediately", WFRecordingEnd="On Tap", WFRecordingCompression="Normal")] if DEEPGRAM else [
    act("gettext", UUID=SAID, WFTextActionText=text("For Zero Proof, the green glass. I love the glow.")) if TEST
      else act("dictatetext", UUID=SAID, WFDictateTextStopListening="On Tap"),
    # Nothing said: type it instead.
    act("conditional", GroupingIdentifier=SAID_G, WFControlFlowMode=0, WFCondition=101, WFInput=var(out("Text" if TEST else "Dictated Text", SAID))),
    act("ask", UUID=ASK, WFAskActionPrompt=PROMPT, WFInputType="Text", WFAllowsMultilineText=True),
    act("setvariable", WFVariableName="Words", WFInput=attach(out("Provided Input", ASK))),
    act("conditional", GroupingIdentifier=SAID_G, WFControlFlowMode=1),
    act("setvariable", WFVariableName="Words", WFInput=attach(out("Text" if TEST else "Dictated Text", SAID))),
    act("conditional", GroupingIdentifier=SAID_G, WFControlFlowMode=2)]),
    act("date", UUID=DATE),
    act("getdevicedetails", UUID=DEV),
    act("repeat.each", GroupingIdentifier=REP_G, WFControlFlowMode=0, WFInput=attach(out("If Result", IF_END))),
    # A link is saved as a link (Recall fetches its picture); anything else as a file.
    act("detect.link", UUID=LINK, WFInput=attach(REPEAT_ITEM)),
    act("conditional", GroupingIdentifier=LINK_G, WFControlFlowMode=0, WFInput=var(out("URLs", LINK)), **is_link),
    post(field("url", token(out("URLs", LINK)))),
    act("conditional", GroupingIdentifier=LINK_G, WFControlFlowMode=1),
    post({"WFItemType": 5, "WFKey": text("files"), "WFValue": {"Value": attach(REPEAT_ITEM), "WFSerializationType": "WFTokenAttachmentParameterState"}}),
    act("conditional", UUID=LINK_END, GroupingIdentifier=LINK_G, WFControlFlowMode=2),
    # The library answers {"ok": true}. Anything else: say so and stop, so nothing is silently lost.
    act("getvalueforkey", UUID=OK, WFDictionaryKey="ok", WFInput=attach(out("If Result", LINK_END))),
    act("conditional", GroupingIdentifier=OK_G, WFControlFlowMode=0, WFCondition=101, WFInput=var(out("Dictionary Value", OK))),
    act("alert", WFAlertActionTitle="Not saved", WFAlertActionMessage=text("Recall didn't take that one. Check your connection and run it again; anything already saved stays saved."), WFAlertActionCancelButtonShown=False),
    act("exit"),
    act("conditional", GroupingIdentifier=OK_G, WFControlFlowMode=2),
    act("repeat.each", GroupingIdentifier=REP_G, WFControlFlowMode=2),
    act("notification", UUID=U(), WFNotificationActionBody=text("Saved to Recall.")),
]

shortcut = {
    "WFQuickActionSurfaces": ["Finder", "Services"] if MAC else [],  # Mac: right-click any file (Quick Actions) or selected text (Services)
    "WFWorkflowActions": actions, "WFWorkflowClientVersion": "4711",
    "WFWorkflowHasOutputFallback": False, "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": 59511, "WFWorkflowIconStartColor": 4282601983},
    "WFWorkflowImportQuestions": [],
    "WFWorkflowInputContentItemClasses": ["WFImageContentItem", "WFPhotoMediaContentItem", "WFAVAssetContentItem", "WFGenericFileContentItem", "WFPDFContentItem", "WFURLContentItem", "WFSafariWebPageContentItem", "WFStringContentItem", "WFRichTextContentItem"],
    "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowTypes": ["ActionExtension", "WFWorkflowTypeShowInSearch"] + (["QuickActions", "MenuBar"] if MAC else []),
}
with open(OUT, "wb") as f: plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
print("ok")
