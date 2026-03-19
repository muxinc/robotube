import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";
import mux from "convex-mux-component/convex.config.js";

const app = defineApp();
app.use(agent);
app.use(mux, { name: "mux" });

export default app;
