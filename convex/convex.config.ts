import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";

// App-owned root routing: the component is mounted without an httpPrefix and
// the static catch-all is registered last in convex/http.ts. This keeps the
// app's own HTTP routes at their canonical root paths — Convex Auth's
// /.well-known/openid-configuration + /.well-known/jwks.json (the backend
// fetches these at the deployment root to validate JWTs) and the AgentMail
// inbound webhook — instead of moving them under /api.
const app = defineApp();
app.use(staticHosting);

export default app;
