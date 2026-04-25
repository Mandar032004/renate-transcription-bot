#!/usr/bin/env bash
# Boots Xvfb (virtual display) + PulseAudio (virtual null sink), then execs
# the bot. Headful Chromium inside Xvfb is used instead of headless-shell
# because headless-shell doesn't route audio to PulseAudio — the whole
# point of this bot is capturing Meet audio, so we need the full browser.

set -euo pipefail

mkdir -p /chunks /var/run/pulse /var/lib/pulse /root/.config/pulse /tmp/.X11-unix

# Explicit socket path so Chromium can find the PulseAudio server regardless
# of XDG_RUNTIME_DIR / HOME discovery quirks. Exporting it here means every
# child process (Playwright → Chromium) inherits it.
export PULSE_SERVER="unix:/tmp/pulse-socket"
rm -f /tmp/pulse-socket || true

# --- Xvfb ---
export DISPLAY=":99"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!

for i in $(seq 1 30); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    echo "[entrypoint] Xvfb ready after ${i} attempts"
    break
  fi
  sleep 0.2
done

if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "[entrypoint] ERROR: Xvfb failed to start" >&2
  exit 1
fi

# --- PulseAudio ---
pulseaudio \
  --exit-idle-time=-1 \
  --disallow-exit=false \
  --disable-shm=true \
  --log-target=stderr \
  --daemonize=true \
  -L "module-native-protocol-unix socket=/tmp/pulse-socket auth-anonymous=1"

for i in $(seq 1 30); do
  if pactl info >/dev/null 2>&1; then
    echo "[entrypoint] pulseaudio ready after ${i} attempts"
    break
  fi
  sleep 0.3
done

if ! pactl info >/dev/null 2>&1; then
  echo "[entrypoint] ERROR: pulseaudio failed to start" >&2
  exit 1
fi

pactl load-module module-null-sink \
  sink_name=meet_sink \
  sink_properties=device.description=MeetSink >/dev/null

# Second null sink acts as the bot's virtual microphone. Format aligned with
# Sarvam TTS output (22050Hz mono s16le) so paplay writes bytes 1:1 — no
# resampling to confuse Chromium's AGC/AEC stack.
pactl load-module module-null-sink \
  sink_name=mic_sink \
  rate=22050 channels=1 format=s16le \
  sink_properties=device.description=MicSink >/dev/null

# Expose mic_sink.monitor as a PROPER non-monitor source. WebRTC filters
# sources flagged with device.class=monitor out of the getUserMedia mic
# list, so Meet couldn't see mic_sink.monitor. module-remap-source clones
# the monitor into virtual_mic with no monitor flag — Chromium/Meet see it
# as a regular microphone and open it for capture.
pactl load-module module-remap-source \
  master=mic_sink.monitor \
  source_name=virtual_mic \
  source_properties=device.description=VirtualMic >/dev/null

pactl set-default-sink meet_sink            # Meet audio OUT -> captured
pactl set-default-source virtual_mic        # Chromium mic IN  <- paplay→mic_sink→remap

pactl list short sinks | grep -q meet_sink || { echo "[entrypoint] ERROR: meet_sink missing" >&2; exit 1; }
pactl list short sinks | grep -q mic_sink  || { echo "[entrypoint] ERROR: mic_sink missing"  >&2; exit 1; }
pactl list short sources | grep -q virtual_mic || { echo "[entrypoint] ERROR: virtual_mic missing" >&2; exit 1; }

echo "[entrypoint] DISPLAY=${DISPLAY}; PULSE_SERVER=${PULSE_SERVER}; default sink=meet_sink; default source=virtual_mic"

# Verbose audio diagnostics so we can confirm Chromium later opens virtual_mic.
pactl list sources short | awk '{print "[entrypoint] source:", $0}'
pactl list sinks   short | awk '{print "[entrypoint] sink:  ", $0}'

# Propagate SIGTERM to all children so docker stop completes quickly.
_term() {
  echo "[entrypoint] received SIGTERM"
  kill -TERM "${BOT_PID:-0}" 2>/dev/null || true
  kill -TERM "${XVFB_PID:-0}" 2>/dev/null || true
}
trap _term SIGTERM SIGINT

"$@" &
BOT_PID=$!
wait "$BOT_PID"
