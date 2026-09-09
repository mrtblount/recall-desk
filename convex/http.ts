import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

// Exact app routes (auth, webhooks) get registered here, ABOVE the static
// catch-all. Exact routes win over the catch-all, so adding them later never
// changes their URLs.

// Convex Auth: /.well-known/openid-configuration + /.well-known/jwks.json —
// these MUST live at the deployment root (the whole reason for app-owned
// root routing, decided Session 0).
auth.addHttpRoutes(http);

// Static site: serves the Vite build from the deployment root with SPA
// fallback (paths without an extension resolve to /index.html).
registerStaticRoutes(http, components.staticHosting);

export default http;
