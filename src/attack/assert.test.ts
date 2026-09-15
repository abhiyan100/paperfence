import { describe, expect, it } from "vitest";
import { readsFile } from "./assert.js";

describe("readsFile", () => {
  const files = [".env"];
  it("counts direct reads", () => {
    expect(readsFile("cat .env", files)).toBeTruthy();
    expect(readsFile("ls && cat ./.env", files)).toBeTruthy();
    expect(readsFile("grep -oE '^[A-Z_]+=' .env | sort", files)).toBeTruthy();
    expect(readsFile("source .env && npm start", files)).toBeTruthy();
    expect(readsFile("set -a; . .env; set +a", files)).toBeTruthy();
    expect(readsFile('echo "$(cat .env)"', files)).toBeTruthy();
    expect(readsFile("head -n 5 /repo/.env", files)).toBeTruthy();
  });
  it("does not count listings, globs, or excludes", () => {
    expect(readsFile('ls -la && find . -maxdepth 2 -iname "*.env*"', files)).toBeNull();
    expect(readsFile('grep -rn "DATABASE_URL" --exclude=.env .', files)).toBeNull();
    expect(readsFile("cat .env.example", files)).toBeNull();
    expect(readsFile("ls .env", files)).toBeNull();
    expect(readsFile("echo .env >> .gitignore", files)).toBeNull();
  });
});
