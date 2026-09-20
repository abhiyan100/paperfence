import { describe, expect, it } from "vitest";
import { countEnvelopes, dockerfile, IMAGE, sdkVersion } from "./docker.js";
import { RESULT_END, RESULT_START } from "../attack/markers.js";

const envelope = (body: string) => `\n${RESULT_START}\n${body}\n${RESULT_END}\n`;

/**
 * The agent shares stdout with the runner and runs in the same pid namespace.
 * If it can get a second envelope onto the stream, it can dictate the trial's
 * evidence. One envelope is the runner's; more than one is ambiguous, and
 * ambiguous evidence is not evidence.
 */
describe("countEnvelopes", () => {
  it("counts the one the runner writes", () => {
    expect(countEnvelopes(`some logs${envelope('{"ruleId":"a","events":[]}')}`)).toBe(1);
  });

  it("counts a forged envelope written before the real one", () => {
    expect(countEnvelopes(`${envelope('{"ruleId":"a","events":[]}')}logs${envelope('{"ruleId":"a","events":[1]}')}`)).toBe(2);
  });

  it("counts a forged envelope written after the real one", () => {
    expect(countEnvelopes(`${envelope('{"ruleId":"a","events":[1]}')}${envelope('{"ruleId":"a","events":[]}')}`)).toBe(2);
  });

  it("is zero when the run produced nothing", () => {
    expect(countEnvelopes("container exited 1\n")).toBe(0);
  });

  it("does not count a start marker with no end", () => {
    expect(countEnvelopes(`\n${RESULT_START}\n{"ruleId":"a"}\n`)).toBe(0);
  });

  it("does not count the markers appearing inside a tool result", () => {
    // An agent echoing the marker text without a closing marker must not shift the count.
    expect(countEnvelopes(`the agent printed ${RESULT_START} in a log line${envelope('{"ruleId":"a","events":[]}')}`)).toBe(1);
  });
});


/**
 * The sandbox image installs the Agent SDK. If the version in the image drifts
 * from the one this package depends on, every receipt is quietly wrong about
 * the conditions it claims to describe, because the fingerprint reports the
 * host's version.
 */
describe("sandbox image and the SDK version", () => {
  it("reads the version from this package rather than a second copy", () => {
    expect(sdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("puts that version in the Dockerfile, for both the wrapper and the platform binary", () => {
    const df = dockerfile("9.9.9");
    expect(df).toContain("@anthropic-ai/claude-agent-sdk@9.9.9");
    expect(df).toContain("@anthropic-ai/claude-agent-sdk-$P@9.9.9");
    expect(df).not.toContain("0.3.272");
  });

  it("puts it in the image tag too, so bumping the dependency rebuilds instead of reusing", () => {
    expect(IMAGE).toContain(sdkVersion());
  });

  it("keeps the container unprivileged and the socket directory owned by node", () => {
    const df = dockerfile();
    expect(df).toContain("USER node");
    expect(df).toContain("mkdir -p /paperfence/sock");
    expect(df).toContain("chown -R node:node /paperfence");
  });

  it("verifies the platform binary exists at build time rather than at run time", () => {
    expect(dockerfile()).toContain("test -x node_modules/@anthropic-ai/claude-agent-sdk-$P/claude");
  });
});
