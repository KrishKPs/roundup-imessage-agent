// Resets the running server and creates the demo trip "Beach day" (code BEACH7).
// Run while `npm run dev` is running: `npm run seed`. Phones and names come from .env.
import "dotenv/config";

const port = process.env.PORT || "3000";
const res = await fetch(`http://localhost:${port}/api/seed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const body = await res.json();
if (!res.ok) {
  console.error("seed failed:", body.error);
  process.exit(1);
}
console.log(`seeded "${body.trip.title}" with code ${body.trip.code}: ${body.trip.members.map((m: { name: string }) => m.name).join(", ")}`);
