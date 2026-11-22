import { PianoAudio } from "./audio.js";

const STORAGE_KEY = "piano_orthophonie_settings_v1";
const MIN_FRENCH_OCTAVE = 1; // Do1 (MIDI 36)
const MAX_FRENCH_OCTAVE = 5; // Do5..Si6 (MIDI 84..107)
const DEFAULT_SETTINGS = Object.freeze({
  soundMode: "natural",
  showLabels: true,
  baseOctave: 3, // French Do3 = Middle C (MIDI 60, 261.63 Hz)
});

// Two octaves = 14 white keys + 10 black keys
const OCTAVE_PATTERN = [
  { offset: 0, name: "Do", black: false },
  { offset: 1, name: "Do#", black: true },
  { offset: 2, name: "Ré", black: false },
  { offset: 3, name: "Ré#", black: true },
  { offset: 4, name: "Mi", black: false },
  { offset: 5, name: "Fa", black: false },
  { offset: 6, name: "Fa#", black: true },
  { offset: 7, name: "Sol", black: false },
  { offset: 8, name: "Sol#", black: true },
  { offset: 9, name: "La", black: false },
  { offset: 10, name: "La#", black: true },
  { offset: 11, name: "Si", black: false },
];

// Desktop computer keyboard shortcut map (one octave + top C) for convenience
const KEYBOARD_MAP = new Map([
  ["a", 0],
  ["w", 1],
  ["s", 2],
  ["e", 3],
  ["d", 4],
  ["f", 5],
  ["t", 6],
  ["g", 7],
  ["y", 8],
  ["h", 9],
  ["u", 10],
  ["j", 11],
  ["k", 12],
]);

const audio = new PianoAudio();
const settings = loadSettings();

const keyboardEl = document.getElementById("keyboard");
const octaveLabelEl = document.getElementById("octave-label");
const octaveDownBtn = document.getElementById("octave-down");
const octaveUpBtn = document.getElementById("octave-up");
const settingsBtn = document.getElementById("settings-btn");
const settingsDialog = document.getElementById("settings-dialog");
const soundModeButtons = Array.from(document.querySelectorAll("[data-sound-mode]"));
const toggleLabelsInput = document.getElementById("toggle-labels");
const installBtn = document.getElementById("install-btn");
const installDialog = document.getElementById("install-dialog");

/** @type {Map<number, { midi: number, keyEl: HTMLElement }>} */
const activePointers = new Map();
/** @type {Map<string, number>} */
const activeKeyCodes = new Map();
/** @type {Map<number, { count: number, handle: { stop: () => void } }>} */
const activeVoices = new Map();
/** @type {Map<number, HTMLElement>} */
const keyByMidi = new Map();

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      soundMode: parsed.soundMode === "sustained" ? "sustained" : "natural",
      showLabels: typeof parsed.showLabels === "boolean" ? parsed.showLabels : true,
      baseOctave: clampOctave(Number(parsed.baseOctave)),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors in private browsing.
  }
}

function clampOctave(val) {
  if (!Number.isFinite(val)) return DEFAULT_SETTINGS.baseOctave;
  return Math.min(MAX_FRENCH_OCTAVE, Math.max(MIN_FRENCH_OCTAVE, Math.round(val)));
}

function frenchOctaveToBaseMidi(frenchOctave) {
  // French Do3 = MIDI 60 (C4 scientific pitch)
  return (frenchOctave + 2) * 12;
}

function isStandalonePWA() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

const KEYBOARD_KEYS = [
  ...OCTAVE_PATTERN.map((def) => ({ ...def, semitone: def.offset, octOffset: 0 })),
  { offset: 0, name: "Do", black: false, semitone: 12, octOffset: 1 },
];
const WHITE_KEY_TOTAL = 8;

function renderKeyboard() {
  releaseAllNotes();
  keyboardEl.replaceChildren();
  keyByMidi.clear();

  keyboardEl.style.setProperty("--white-keys", String(WHITE_KEY_TOTAL));

  const baseMidi = frenchOctaveToBaseMidi(settings.baseOctave);
  let whiteCount = 0;

  for (const def of KEYBOARD_KEYS) {
    const midi = baseMidi + def.semitone;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = def.black ? "key key--black" : "key key--white";
    if (def.offset === 0) {
      btn.classList.add("is-c");
    }
    btn.dataset.midi = String(midi);
    btn.setAttribute("aria-label", `${def.name}${settings.baseOctave + def.octOffset}`);

    if (def.black) {
      // Place black key centered cleanly on the seam after the previous white key.
      btn.style.left = `${(whiteCount / WHITE_KEY_TOTAL) * 100}%`;
    } else {
      const label = document.createElement("span");
      label.className = "key-label";
      label.textContent = def.name;
      btn.appendChild(label);
      whiteCount += 1;
    }

    keyboardEl.appendChild(btn);
    keyByMidi.set(midi, btn);
  }

  octaveLabelEl.textContent = `Do${settings.baseOctave} – Do${settings.baseOctave + 1}`;
  octaveDownBtn.disabled = settings.baseOctave <= MIN_FRENCH_OCTAVE;
  octaveUpBtn.disabled = settings.baseOctave >= MAX_FRENCH_OCTAVE;
}

function syncUI() {
  keyboardEl.classList.toggle("hide-labels", !settings.showLabels);
  toggleLabelsInput.checked = settings.showLabels;
  for (const btn of soundModeButtons) {
    const isSelected = btn.dataset.soundMode === settings.soundMode;
    btn.setAttribute("aria-checked", String(isSelected));
  }
  installBtn.hidden = isStandalonePWA();
}

function pressNote(midi) {
  const existing = activeVoices.get(midi);
  if (existing) {
    existing.count += 1;
    return;
  }

  const handle = audio.playNote(midi, settings.soundMode);
  activeVoices.set(midi, { count: 1, handle });
  keyByMidi.get(midi)?.classList.add("is-active");
}

function releaseNote(midi) {
  const existing = activeVoices.get(midi);
  if (!existing) return;

  existing.count -= 1;
  if (existing.count <= 0) {
    existing.handle.stop();
    activeVoices.delete(midi);
    keyByMidi.get(midi)?.classList.remove("is-active");
  }
}

function releaseAllNotes() {
  for (const [midi, voice] of activeVoices.entries()) {
    voice.handle.stop();
    keyByMidi.get(midi)?.classList.remove("is-active");
  }
  activeVoices.clear();
  activePointers.clear();
  activeKeyCodes.clear();
}

function keyElementFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest(".key") : null;
}

function handlePointerDown(e) {
  if (e.button !== 0 && e.pointerType === "mouse") return;
  const keyEl = e.target.closest(".key");
  if (!keyEl) return;

  e.preventDefault();
  audio.unlock();

  const midi = Number(keyEl.dataset.midi);
  if (!Number.isFinite(midi)) return;

  activePointers.set(e.pointerId, { midi, keyEl });
  pressNote(midi);
}

function handlePointerMove(e) {
  const active = activePointers.get(e.pointerId);
  if (!active) return;

  const nextKeyEl = keyElementFromPoint(e.clientX, e.clientY);
  if (nextKeyEl === active.keyEl) return;

  releaseNote(active.midi);

  if (nextKeyEl && keyboardEl.contains(nextKeyEl)) {
    const nextMidi = Number(nextKeyEl.dataset.midi);
    if (Number.isFinite(nextMidi)) {
      activePointers.set(e.pointerId, { midi: nextMidi, keyEl: nextKeyEl });
      pressNote(nextMidi);
      return;
    }
  }

  activePointers.delete(e.pointerId);
}

function handlePointerEnd(e) {
  const active = activePointers.get(e.pointerId);
  if (!active) return;
  activePointers.delete(e.pointerId);
  releaseNote(active.midi);
}

function setupModalDismiss(dialog) {
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      dialog.close();
    }
  });
}

// Pointer events for responsive iPhone multi-touch & glissando
keyboardEl.addEventListener("pointerdown", handlePointerDown);
window.addEventListener("pointermove", handlePointerMove);
window.addEventListener("pointerup", handlePointerEnd);
window.addEventListener("pointercancel", handlePointerEnd);
keyboardEl.addEventListener("contextmenu", (e) => e.preventDefault());

// Safety cleanup when switching apps or locking iPhone
window.addEventListener("blur", releaseAllNotes);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    releaseAllNotes();
  }
});

// Octave shift controls
octaveDownBtn.addEventListener("click", () => {
  const next = clampOctave(settings.baseOctave - 1);
  if (next !== settings.baseOctave) {
    settings.baseOctave = next;
    saveSettings();
    renderKeyboard();
  }
});

octaveUpBtn.addEventListener("click", () => {
  const next = clampOctave(settings.baseOctave + 1);
  if (next !== settings.baseOctave) {
    settings.baseOctave = next;
    saveSettings();
    renderKeyboard();
  }
});

// Settings modal
settingsBtn.addEventListener("click", () => {
  settingsDialog.showModal();
});

for (const btn of soundModeButtons) {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.soundMode === "sustained" ? "sustained" : "natural";
    settings.soundMode = mode;
    saveSettings();
    syncUI();
  });
}

toggleLabelsInput.addEventListener("change", () => {
  settings.showLabels = toggleLabelsInput.checked;
  saveSettings();
  syncUI();
});

// Install modal (shown only when not already installed as PWA)
installBtn.addEventListener("click", () => {
  installDialog.showModal();
});

setupModalDismiss(settingsDialog);
setupModalDismiss(installDialog);

window.matchMedia("(display-mode: standalone)").addEventListener("change", syncUI);

// Optional desktop keyboard playability
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (settingsDialog.open || installDialog.open) return;

  const offset = KEYBOARD_MAP.get(e.key.toLowerCase());
  if (offset === undefined) return;

  const midi = frenchOctaveToBaseMidi(settings.baseOctave) + offset;
  if (!keyByMidi.has(midi)) return;

  audio.unlock();
  activeKeyCodes.set(e.code, midi);
  pressNote(midi);
});

window.addEventListener("keyup", (e) => {
  const midi = activeKeyCodes.get(e.code);
  if (midi === undefined) return;
  activeKeyCodes.delete(e.code);
  releaseNote(midi);
});

// Register offline Service Worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

renderKeyboard();
syncUI();
