// Gives the website a public https address so trip links open on anyone's phone.
// Uses a free Cloudflare quick tunnel (`cloudflared`, no account needed). The address changes on every run.
import { spawn, type ChildProcess } from "node:child_process";

export interface Tunnel {
  url: string | undefined;
  stop(): void;
}

export function startTunnel(port: number): Tunnel {
  const tunnel: Tunnel = { url: undefined, stop: () => undefined };
  let child: ChildProcess;
  try {
    child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    console.warn(`[tunnel] could not start cloudflared: ${(err as Error).message}`);
    return tunnel;
  }
  let candidate: string | undefined;
  let warned = false;
  const watch = (chunk: Buffer) => {
    const text = chunk.toString();
    candidate ??= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    // The address is printed before it works; only use it once Cloudflare says the connection is up.
    if (candidate && !tunnel.url && /Registered tunnel connection/.test(text)) {
      tunnel.url = candidate;
      console.log(`[tunnel] public website: ${tunnel.url}  (open this on your phone to create a trip)`);
    }
    if (!warned && /port 7844/.test(text)) {
      warned = true;
      console.warn("[tunnel] this network blocks Cloudflare tunnels (port 7844). Try a phone hotspot. Retrying...");
    }
  };
  child.stdout?.on("data", watch);
  child.stderr?.on("data", watch);
  child.on("error", (err) => console.warn(`[tunnel] cloudflared not available (brew install cloudflared): ${err.message}`));
  child.on("exit", (code) => {
    if (code) console.warn(`[tunnel] cloudflared stopped (exit ${code}); trip links will only work on this laptop`);
    tunnel.url = undefined;
  });
  tunnel.stop = () => child.kill();
  return tunnel;
}
