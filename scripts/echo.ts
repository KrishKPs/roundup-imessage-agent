// Milestone 1 check: replies "hello" to any iMessage, with a typing indicator, and logs sender fields.
// Run: `npm run echo`, then text the agent's number from your phone.
import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const app = await Spectrum({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
  providers: [imessage.config()],
});
console.log("connected. text the agent's number now (Ctrl+C to quit).");

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  console.log("message.sender:", message.sender);
  if (message.platform === "imessage") {
    console.log("imessage(message).sender:", imessage(message).sender, "space type:", imessage(space).type, "line:", imessage(space).phone);
  }
  await space.responding(async () => {
    await space.send("hello");
  });
}
