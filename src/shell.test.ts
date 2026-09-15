import { describe, expect, it } from "vitest";
import { allSegments, parseSegment, splitTopLevel, subshells, words } from "./shell.js";

describe("splitTopLevel", () => {
  it("splits on separators outside quotes", () => {
    expect(splitTopLevel("a && b | c; d & e\nf")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(splitTopLevel("echo 'safe; git push origin main'")).toEqual(["echo 'safe; git push origin main'"]);
    expect(splitTopLevel('echo "a && b" && c')).toEqual(['echo "a && b"', "c"]);
    expect(splitTopLevel("(cd x && rm -rf y) && z")).toEqual(["(cd x && rm -rf y)", "z"]);
  });
});

describe("subshells", () => {
  it("finds $(...), backticks and (...)", () => {
    expect(subshells("echo $(cat .env)")).toEqual(["cat .env"]);
    expect(subshells("echo `cat .env`")).toEqual(["cat .env"]);
    expect(subshells("(cd x && rm -rf y)")).toEqual(["cd x && rm -rf y"]);
    expect(subshells("printf '%s' '$(cat .env)'")).toEqual([]); // single quotes are literal
    expect(subshells('echo "$(cat .env)"')).toEqual(["cat .env"]); // double quotes still expand
  });
});

describe("words / parseSegment", () => {
  it("strips quotes and marks quoted words", () => {
    expect(words("echo 'a b' c")).toEqual([
      { text: "echo", quoted: false },
      { text: "a b", quoted: true },
      { text: "c", quoted: false },
    ]);
  });
  it("parses program, wrappers, env, redirects", () => {
    const s = parseSegment("FOO=1 env -i sudo /usr/bin/cat .env > out.txt 2>&1 < in.txt");
    expect(s.base).toBe("cat");
    expect(s.args.map((a) => a.text)).toEqual([".env"]);
    expect(s.writes).toEqual(["out.txt"]);
    expect(s.reads).toEqual(["in.txt"]);
    expect(parseSegment("xargs grep pattern").base).toBe("grep");
    expect(parseSegment("timeout 5 curl x").base).toBe("curl");
    expect(parseSegment("command git push").base).toBe("git");
  });
});

describe("edge cases from review", () => {
  it("apostrophe inside double quotes is not a quote", () => {
    expect(subshells('echo "it\'s $(cat .env)"')).toEqual(["cat .env"]);
    expect(subshells('printf \'%s\' "literal (cat .env)"')).toEqual([]);
  });
  it("quoted env assignment and wrapper option values", () => {
    expect(parseSegment("VAR='safe' cat .env").base).toBe("cat");
    expect(parseSegment("nice -n 10 cat .env").base).toBe("cat");
    expect(parseSegment("env -i cat .env").base).toBe("cat");
  });
  it("attached and quoted redirects", () => {
    expect(parseSegment("cat<.env").reads).toEqual([".env"]);
    expect(parseSegment('printf x >"tests/a.test.js"').writes).toEqual(["tests/a.test.js"]);
    expect(parseSegment("cmd 2>&1").writes).toEqual([]);
  });
  it("command -v is a lookup, not a wrapper", () => {
    expect(parseSegment("command -v curl").base).toBe("command");
  });
});

describe("allSegments", () => {
  it("includes subshell bodies", () => {
    const bases = allSegments("ls && echo $(rm -rf build)").map((s) => s.base);
    expect(bases).toEqual(["ls", "echo", "rm"]);
  });
  it("does not split inside quotes", () => {
    const segs = allSegments("echo 'safe; git push origin main'");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.base).toBe("echo");
  });
});
