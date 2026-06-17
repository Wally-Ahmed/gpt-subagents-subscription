import { runLoginFlow } from "./oauth.js";
import { saveTokens, clearTokens } from "./tokens.js";
import { getUsage } from "./client.js";
import { TOKEN_FILE } from "./config.js";

async function main() {
  if (process.argv.includes("--logout")) {
    clearTokens();
    console.error(`Logged out. Removed ${TOKEN_FILE}`);
    return;
  }
  console.error("Starting ChatGPT OAuth login (a browser window will open)...");
  const tokens = await runLoginFlow();
  saveTokens(tokens);
  console.error(`\n✅ Logged in. Tokens saved to ${TOKEN_FILE}`);
  try {
    console.error("\nCurrent usage:\n" + (await getUsage()));
  } catch {
    /* usage is best-effort; ignore failures here */
  }
}

main().catch((err) => {
  console.error("Login failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
