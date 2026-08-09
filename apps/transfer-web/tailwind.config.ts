import type { Config } from "tailwindcss";
import preset from "@bos/ui/tailwind.preset";

const config: Config = {
  presets: [preset as Config],
  content: ["./app/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
};

export default config;
