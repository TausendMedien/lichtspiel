# ANALYSE — Button-Konsistenz · UX für Erstnutzer:innen · Kamera-Zuverlässigkeit

Stand: 2026-07-13 · Basis: `main` nach v0.7 (Filter/Pose/Controls-Umbau).

**Update 2026-07-13 (später am selben Tag): alles umgesetzt.** Alle K- und U-Befunde (K1–K9, U1–U6), das Button-System (Abschnitt 5) und die zentrale CameraManager-Abstraktion (`src/lib/cameraManager.ts`, referenzgezählt, migriert: Motion/Heat-Wrapper, Pose, Light-Painting-Familie, ASCII Swirls) sind implementiert und im Browser verifiziert. Dieses Dokument bleibt als Analyse-Historie stehen; der ursprüngliche Umsetzungsplan unten ist vollständig abgearbeitet.

**Priorität:** Kritisch = kann eine Live-Show sichtbar stören · Hoch = führt regelmäßig zu Fehlverhalten oder Verwirrung · Mittel = spürbar, aber mit Workaround · Niedrig = Kosmetik/Politur.
**Aufwand:** S ≤ 1 h · M = halber Tag · L = mehrere Tage.

---

## 7. Kamera-Zuverlässigkeit (zuerst — hier liegen die Live-Risiken)

### Architektur-Befund (Überblick)

Es gibt **keinen zentralen Kamera-Owner**. Vier Consumer öffnen unabhängig eigene `getUserMedia`-Streams:

| Consumer | Ort | Stream-Besitz |
|---|---|---|
| Motion/Heat | [motionCameraWrapper.ts:30](src/lib/motionCameraWrapper.ts:30) | modul-globales `_motionCamera` (geteilt über alle Patterns) |
| Pose | [pose.ts:57](src/lib/pose.ts:57) | modul-globale `video`/`landmarker` |
| Light-Paint-Familie | [light-paint.ts:346](src/lib/patterns/light-paint.ts:346) | Closure pro Pattern |
| ASCII Swirls | [asciiSwirls.ts:251](src/lib/patterns/asciiSwirls.ts:251) | Closure pro Pattern |

Die einzige Koordination ist [sensorGuard.ts](src/lib/sensorGuard.ts) — ein reines Kill-Switch-Register (Sensor Block), **keine Referenzzählung**: Wer einen Stream startet, muss ihn selbst stoppen; niemand weiß, ob ein anderer Consumer denselben Bedarf noch hat. Motion und Pose können gleichzeitig zwei getrennte Streams derselben Kamera halten.

### Befunde

**K1 · Kritisch — Kamera startet beim App-Load, ohne dass etwas sie sichtbar nutzt.**
[renderer.ts:297](src/lib/renderer.ts:297) ruft beim Erstellen `current.activate?.()` auf `patterns[0]` auf — das ist Hyper Mix Heat, dessen `activate()` ([hyperMixHeat.ts:288](src/lib/patterns/hyperMixHeat.ts:288)) global `cameraState.enabled = true` setzt. Folge: Permission-Prompt bzw. LED an, während die Nutzer:in noch in der Pattern-Übersicht ist (im Test reproduziert: Kamera-Request direkt beim Laden). Der v0.6-Fix „called only on real activation (not on overview hover preview)" greift für Hover, aber nicht für diese Initial-Aktivierung.
*Lösung:* In `createRenderer` das initiale `activate()` weglassen (bzw. nur aufrufen, wenn nicht im Overview gestartet wird) — App.svelte ruft `activateCurrentPattern()` ohnehin bei jeder echten Auswahl. *Aufwand: S.*

**K2 · Kritisch — Zombie-Stream nach Pattern-Wechsel zu ungewrappten Patterns.**
`setPattern` ([renderer.ts:286](src/lib/renderer.ts:286)) setzt bei **jedem** Wechsel `keepCameraAlive(true)`, dadurch überspringt `dispose()` des alten Patterns `stopCamera()` ([motionCameraWrapper.ts:365](src/lib/motionCameraWrapper.ts:365)). Wechselt man von einem Kamera-Pattern zu Light Paint oder ASCII Swirls (beide **nicht** vom Motion-Wrapper umhüllt, [patterns/index.ts:45](src/lib/patterns/index.ts:45)), gibt es keinen `update()`-Tick mehr, der `_motionCamera` verwaltet oder stoppt — der Motion-Stream läuft unsichtbar weiter, während Light Paint einen **zweiten** Stream derselben Kamera öffnet. LED bleibt an, iOS-Geräte können den doppelten Zugriff verweigern.
*Lösung:* `keepCameraAlive` nur setzen, wenn das *nächste* Pattern motion-wrapped ist (Flag am Pattern), oder Stop in `setPattern` nachziehen, wenn das neue Pattern den Stream nicht übernimmt. *Aufwand: S–M.*

**K3 · Hoch — Zombie bei per-Pattern deaktiviertem Motion.**
Gleicher Mechanismus innerhalb gewrappter Patterns: Das neue Pattern initialisiert `prevEnabled`/`prevPatternEnabled` mit dem aktuellen Zustand ([motionCameraWrapper.ts:218](src/lib/motionCameraWrapper.ts:218)). Ist für das neue Pattern `patternMotionEnabled == false`, ist `shouldRun == prevShouldRun == false` → der Zweig „stopCamera" ([motionCameraWrapper.ts:247](src/lib/motionCameraWrapper.ts:247)) feuert nie, der vom Vorgänger geerbte `_motionCamera` läuft weiter (und schreibt weiter in `cameraState.heatMap`).
*Lösung:* In `init()`/`activate()` explizit prüfen: „Stream vorhanden, aber shouldRun false → stopCamera()". *Aufwand: S.*

**K4 · Hoch — Kein Recovery bei endendem Track (Device weg, OS-Entzug, Sleep/Wake).**
`sensorGuard` deregistriert Streams beim `ended`-Event nur aus dem Kill-Register ([sensorGuard.ts:27](src/lib/sensorGuard.ts:27)). Der Motion-Wrapper merkt nichts: `_motionCamera` bleibt gesetzt, `tick()` liefert still `null` ([motionDetector.ts:72](src/lib/motionDetector.ts:72)) — UI zeigt Kamera „an", aber es kommt nie wieder ein Bild. Gleiches Muster bei Pose, Light Paint und ASCII. Der `visibilitychange`-Handler ([App.svelte:1997](src/App.svelte:1997)) re-aquiriert nur den WakeLock, prüft keine Streams. Nach iPad-Sleep/Wake in einer Installation heißt das: schwarzes/eingefrorenes Kamerabild bis zum manuellen Neustart.
*Lösung:* Auf jedem Video-Track `ended`/`mute` abonnieren → Consumer benachrichtigen → automatischer Restart-Versuch (mit Backoff), plus Re-Check bei `visibilitychange → visible`. *Aufwand: M.*

**K5 · Hoch — Pose lädt Modell + WASM zur Laufzeit vom CDN.**
[pose.ts:31–38](src/lib/pose.ts:31): `cdn.jsdelivr.net` und `storage.googleapis.com`. Auf einem Festival ohne (stabiles) Internet schlägt Pose immer fehl — vermutlich ein Hauptgrund für „funktioniert nicht zuverlässig". Zudem kein Timeout: hängt das CDN, bleibt `poseLoading` stehen.
*Lösung:* WASM + `pose_landmarker_lite.task` ins Repo/`public/` bundeln und lokal ausliefern; Lade-Timeout mit Fehlermeldung. *Aufwand: M.*

**K6 · Mittel — Race beim Pose-Start über Gerätewechsel/Pattern-Wechsel.**
`startPoseTracking` ist lang-asynchron (CDN, Kamera). Der Restart-Effect bei Device-Wechsel ([App.svelte:556–575](src/App.svelte:556)) und der Pattern-Wechsel-Effect ([App.svelte:653–660](src/App.svelte:653), stoppt Pose wenn `interactiveOn` false) können mitten in einen laufenden Start fallen: `stopPoseTracking()` setzt `active=false`, aber der noch laufende `startPoseTracking`-Promise setzt danach `poseState.active = true` und startet den RAF-Loop mit frischem Stream → Pose läuft, obwohl UI „aus" zeigt. Kein Start-Token wie `_startId` im Motion-Wrapper.
*Lösung:* Start-Token/AbortController in `pose.ts` analog zu `_startId` in [motionCameraWrapper.ts:167](src/lib/motionCameraWrapper.ts:167). *Aufwand: S.*

**K7 · Mittel — `stopCamera()` setzt globale Interaktionswerte hart zurück.**
[motionCameraWrapper.ts:202](src/lib/motionCameraWrapper.ts:202): beim Stoppen `colorC2.colorsV2 = 3.0` und `speedMult = 1.0` — überschreibt einen ggf. manuell gesetzten Colors-Wert der Nutzer:in (Slider springt sichtbar). Live störend, wenn man mitten in der Show die Kamera deaktiviert.
*Lösung:* Nur zurücksetzen, wenn der Wert zuletzt von der Motion-Reaktivität geschrieben wurde (Merker), sonst unangetastet lassen. *Aufwand: S.*

**K8 · Mittel — Doppelte Fehl-Overlays stapeln sich.**
`showMotionOverlay` ([motionDetector.ts:10](src/lib/motionDetector.ts:10)) hängt bei jedem fehlgeschlagenen Start ein neues DOM-Overlay an, ohne alte zu entfernen (Light-Paint/ASCII räumen ihres auf, der Motion-Pfad bei „denied" nicht — im Test standen zwei identische „Camera access denied"-Texte im Seitentext).
*Lösung:* Vor dem Anhängen bestehende Overlays entfernen / Overlay-Singleton pro Canvas. *Aufwand: S.*

**K9 · Niedrig — Svelte-5-Effects sind insgesamt sauber, aber eng gekoppelt.**
Die `$effect`-Blöcke rund um Pattern-Wechsel ([App.svelte:631–680](src/App.svelte:631)) mischen Zustands-Restaurierung und Sensor-Enforcement in einem Effect und verstecken Abhängigkeiten via `untrack` (z. B. `poseActive`). Kein akutes Doppel-Init gefunden, aber jede Erweiterung riskiert Rückkopplungen (Interactive-Toggle ↔ cameraState wird an drei Stellen erzwungen: Pattern-Effect, Interactive-Toggle-Handler, Sensor Block).
*Lösung:* siehe CameraManager-Empfehlung. *Aufwand: —.*

### Empfehlung: zentrale CameraManager-Abstraktion — **ja, lohnt sich**

Die Befunde K2–K4 und K6 sind alle Instanzen desselben Grundproblems: verteilter Besitz ohne Referenzzählung. Skizze:

```
CameraManager (Singleton)
  acquire(consumerId, constraints) → Handle { video, release() }
  - Referenzzählung pro (deviceId, res-Klasse); ein Stream pro Kamera
  - startet lazy, stoppt wenn letzter Consumer released
  - überwacht track.ended/mute → benachrichtigt Consumer, versucht Restart
  - Sensor Block = zentrale Sperre (ersetzt guardedGetUserMedia-Streuung)
Consumers: MotionDetector, Pose, LightPaint, Ascii → nur noch acquire/release
```

Migration schrittweise möglich: zuerst Motion+Pose (teilen sich meist dieselbe Low-Res-Kamera → ein Stream statt zwei), dann die Feed-Patterns. *Aufwand: L (2–3 Tage inkl. Test auf iPad/iPhone/Mac).* Kurzfristig lassen sich K1–K3, K6–K8 aber auch ohne Umbau als Punkt-Fixes beheben (je S).

---

## 5. Button-Konsistenz (Pattern-Menü ↔ Haupt-Screen)

### Ist-Zustand

| Dimension | Pattern-Menü (Kopfzeile, [App.svelte:~2100](src/App.svelte:2100)) | Haupt-Screen (HUD oben links, [App.svelte:4240 ff.](src/App.svelte:4240)) |
|---|---|---|
| Reihenfolge | Fullscreen · Demo · Options · Sensor Block · **?** | Fullscreen · Demo · Options · **? About** · (darunter) ← Patterns · Share · 📷 · Rec; Sensor Block separat links unten im Panel |
| Shortcut im Label | nein („Fullscreen") | ja („Fullscreen (F)", „Demo (D)", …) |
| Icons | ⛶ ⚙ ⊘ vorhanden, Demo ohne Icon | ⛶ ⚙ ? vorhanden, Demo ohne Icon |
| About | nur „?" (unbeschriftet) | „? About (M)" |
| Sensor Block | Button-Form wie alle anderen (rounded-md) | Pill (rounded-full) mit Aktiv-Zustand lila |
| Toggle vs. Öffner | nicht unterscheidbar | Demo/Sensor Block zeigen Aktiv-Zustand, Rest nicht |

### Vorschlag: ein Button-System (Aufwand insgesamt M)

1. **Eine kanonische Reihenfolge** überall: `← Patterns` *(nur Haupt-Screen)* · `⛶ Fullscreen` · `▶ Demo` · `⚙ Options` · `? About` · `⊘ Sensor Block`. Sensor Block immer als letztes Element und immer als Pill mit Aktiv-Farbe (er ist der einzige globale Zustands-Toggle in der Reihe — die abweichende Form darf bleiben, aber dann in beiden Ansichten).
2. **Label-Konvention:** `Icon + Wort` immer; Shortcut in Klammern **nur auf Pointer-Geräten** (auf Touch entfernen — „(F)" ist dort Rauschen). Das „?" im Pattern-Menü bekommt das Label „About" wie im Haupt-Screen.
3. **Zustands-Konvention:** Modal-Öffner (Demo-Modal, Options, About) neutraler Stil; laufende Zustände (Demo aktiv, Sensor Block aktiv, REC) invertiert/farbig mit ●-Präfix — heute mischt der Demo-Button beide Rollen (öffnet Modal ODER stoppt), das darf er behalten, aber der Aktiv-Stil sollte im Pattern-Menü identisch aussehen.
4. **Sekundäraktionen** (Share, Screenshot, Rec) bleiben exklusiv im Haupt-Screen, aber in einer eigenen zweiten Reihe (ist heute schon so) — im Pattern-Menü nicht duplizieren.
5. Umsetzung idealerweise als **eine Svelte-Snippet/Komponente** `HudButton {icon,label,shortcut,active}` statt handkopierter Klassenstrings (heute ~10 Kopien desselben `rounded-md border border-white/15 …`-Strings — dort schleichen sich die Abweichungen ein).

---

## 6. UX für Erstnutzer:innen

Was Erstnutzer:innen heute beim ersten Öffnen sehen: ein Pattern-Grid mit Filter-Chips, fünf Buttons — und (Stand heute, siehe K1) sofort einen Kamera-Permission-Prompt ohne Erklärung. Die About-Seite erklärt Tastenbelegung, aber nicht, *was die App ist* oder was Move/Heat/Audio bedeuten.

Priorisiert nach Nutzen/Aufwand:

**U1 · Hoch, Aufwand S — Kamera-Prompt erst bei Bedarf + ein Satz Kontext.**
Folgt direkt aus K1. Zusätzlich beim ersten kamerabedürftigen Pattern ein Einzeiler-Overlay vor dem Prompt: „Dieses Pattern reagiert auf Kamera-Bewegung — das Bild bleibt auf dem Gerät." Nimmt die größte Erstnutzer-Hürde (unerklärte Kamera-Anfrage = Misstrauen).

**U2 · Hoch, Aufwand S — About-Seite um zwei Abschnitte erweitern.**
(a) „Was ist Lichtspiel?" — zwei Sätze. (b) „Interaktionstypen": je 1–2 Sätze zu ≋ Move, ♨ Heat, ♪ Audio, ⬡ Pose (inkl. „experimentell") + Hinweis „Kamera/Mikrofon werden nur lokal verarbeitet, nichts verlässt das Gerät" und Kamera-Anforderungen (Erlaubnis, Licht). Die Tabelle der Shortcuts existiert schon — davor einordnen. Die Filter-Tooltips aus v0.7 liefern die Texte bereits, sie müssen nur hierhin gespiegelt werden.

**U3 · Hoch, Aufwand S — Filter-Chips selbsterklärend auf Touch.**
Die neuen `title`-Tooltips helfen nur mit Maus. Auf Touch: beim ersten Aktivieren eines Filters eine Einzeiler-Caption unter der Filterleiste einblenden („♨ Heat — Patterns, die auf die Bewegungs-Heatmap der Kamera reagieren"), die nach ein paar Sekunden verschwindet.

**U4 · Mittel, Aufwand M — First-Run-Hint (einmalig, dismissable).**
Beim allerersten Start (localStorage-Flag) ein dezentes 3-Punkte-Overlay über dem Grid: „Pattern antippen zum Starten · F für Vollbild · M für Hilfe". Ein Overlay, kein mehrstufiger Tour-Wizard — die App lebt von sofortigem Ausprobieren. Auf dem Haupt-Screen zeigt die Shortcut-Liste unten links schon viel; der Hint muss nur die Brücke „erste 10 Sekunden" schlagen.

**U5 · Mittel, Aufwand S — Unbeschriftete Symbole entschärfen.**
⊘ (Sensor Block), ~ (Evolving), ★/☆, „exp." haben teils nur Tooltips. Mindestens: `aria-label` + Touch-freundliche Erklärung an einer Stelle (About-Abschnitt „Symbole"). Sensor Block ist das erklärungsbedürftigste Konzept — ein Wort Untertitel im Options-/About-Kontext genügt („blockiert Kamera & Mikrofon sofort, global").

**U6 · Niedrig, Aufwand M — Permission-Fehlpfade freundlicher.**
„Camera access denied. Allow camera in browser settings and reload." ist technisch korrekt, aber Endstation. Besser: Browser-spezifischer Kurzhinweis (Safari/Chrome) + „Erneut versuchen"-Button (nach K4-Fix kann die App den Restart selbst anstoßen, ohne Reload).

**Nicht empfohlen:** ein mehrschrittiges Onboarding/Tutorial (Wizard). Zielgruppe Installation/Publikum → jede Modal-Hürde vor dem ersten Bild ist kontraproduktiv; Demo-Autostart-Kiosks würden es ohnehin nie zeigen.

---

## Empfohlene Reihenfolge der Umsetzung

1. **K1 + K2 + K3** (Kamera an ohne Grund / Zombie-Streams) — größtes Live-Risiko, je S. 
2. **K6 + K8** (Pose-Race, Overlay-Stapel) — S, macht Pose-Experimente gefahrloser.
3. **K5** (Pose offline bundeln) — M, Voraussetzung, damit Pose je „nicht-experimentell" werden kann.
4. **K4** (Track-ended-Recovery) — M, macht Kiosk/Sleep-Wake robust.
5. **U1 + U2 + U3** (Erstnutzer-Basics) — je S, direkt sichtbarer Nutzen.
6. **Button-System (5.)** — M, gut isolierbar.
7. **CameraManager (L)** — strategisch richtig; nach den Punkt-Fixes ohne Zeitdruck angehen.
8. **U4 + U5 + U6, K7** — Politur danach.

**Welche Punkte soll ich umsetzen?** (z. B. „1–2", „nur K1", „alles bis M-Aufwand")
