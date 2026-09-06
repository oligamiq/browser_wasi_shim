globalThis.onmessage = (event: MessageEvent<{ channel: string }>) => {
  const channel = new BroadcastChannel(event.data.channel);
  let seq = 0;
  setInterval(() => {
    channel.postMessage({ seq: seq++, type: "control-heartbeat" });
  }, 5);
};
