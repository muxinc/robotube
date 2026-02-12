import { defineApp } from "convex/server";
import mux from "convex-mux-component/convex.config.js";

const app = defineApp();
app.use(mux, { name: "mux" });

export default app;
