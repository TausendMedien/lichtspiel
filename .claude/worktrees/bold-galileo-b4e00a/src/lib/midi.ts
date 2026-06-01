// MIDI controller — mirrors gamepad.ts.
// Supports Lumi Keys and any class-compliant MIDI device.
//
// Default mapping:
//   CC 1–8  → setSlider 0–7 (mod wheel and friends)
//   Notes C3–B3 (MIDI 48–59) → jump to pattern 0–11
//   Pitch Bend  → speedUp / speedDown
//   CC 64 ≥ 64  → freeze (sustain pedal)
//   CC 118      → prev
//   CC 119      → next
//   CC 120      → resetToDefault
//   CC 121      → randomize

import type { KeyAction } from './keyboard';

export type MIDIAction =
  | KeyAction
  | { type: 'setSlider'; index: number; value: number };

export interface MIDIController {
  dispose(): void;
}

export function createMIDIController(
  handler: (action: MIDIAction) => void,
  onConnectionChange: (connected: boolean) => void,
): MIDIController {
  let access: MIDIAccess | null = null;
  let connected = false;

  // Pitch bend: emit speed actions only when crossing threshold bands to avoid spam
  let lastPitchRegion = 0; // -1 down, 0 center, 1 up

  function handleMessage(msg: MIDIMessageEvent) {
    const [status, data1, data2] = msg.data;
    const type = status & 0xf0;

    if (type === 0x90 && data2 > 0) {
      // Note On — C3=48 through B3=59 → jump to pattern 0–11
      if (data1 >= 48 && data1 <= 59) {
        handler({ type: 'jump', index: data1 - 48 });
      }
    } else if (type === 0xb0) {
      // Control Change
      if (data1 >= 1 && data1 <= 8) {
        handler({ type: 'setSlider', index: data1 - 1, value: data2 / 127 });
      } else if (data1 === 64) {
        if (data2 >= 64) handler({ type: 'freeze' });
      } else if (data1 === 118) {
        handler({ type: 'prev' });
      } else if (data1 === 119) {
        handler({ type: 'next' });
      } else if (data1 === 120) {
        handler({ type: 'resetToDefault' });
      } else if (data1 === 121) {
        handler({ type: 'randomize' });
      }
    } else if (type === 0xe0) {
      // Pitch Bend — 14-bit value, center = 8192
      const bend = ((data2 << 7) | data1) - 8192;
      const region = bend > 2000 ? 1 : bend < -2000 ? -1 : 0;
      if (region !== lastPitchRegion) {
        if (region === 1) handler({ type: 'speedUp' });
        else if (region === -1) handler({ type: 'speedDown' });
        lastPitchRegion = region;
      }
    }
  }

  function attachPorts(acc: MIDIAccess) {
    acc.inputs.forEach(port => {
      port.onmidimessage = handleMessage;
    });
    const hasInputs = acc.inputs.size > 0;
    if (hasInputs !== connected) {
      connected = hasInputs;
      onConnectionChange(connected);
    }
  }

  function onStateChange() {
    if (access) attachPorts(access);
  }

  navigator.requestMIDIAccess?.({ sysex: false }).then(acc => {
    access = acc;
    acc.onstatechange = onStateChange;
    attachPorts(acc);
  }).catch(e => {
    console.warn('[midi] access denied:', e);
  });

  return {
    dispose() {
      if (access) {
        access.inputs.forEach(port => { port.onmidimessage = null; });
        access.onstatechange = null;
      }
      access = null;
    },
  };
}
