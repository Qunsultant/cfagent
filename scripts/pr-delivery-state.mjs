#!/usr/bin/env node
/**
 * Issue #5569 / #5570 — print one pull request's delivery state, from the two
 * signals `mergeStateStatus` cannot give you.
 *
 * Usage (the JSON shape `gh` already returns):
 *
 *   gh pr view 123 --json number,state,isDraft,mergeStateStatus,autoMergeRequest \
 *     | node scripts/pr-delivery-state.mjs
 *
 *   # or, with isInMergeQueue (GraphQL-only field):
 *   gh api graphql -F owner=OWNER -F name=REPO -F number=123 -f query='
 *     query($owner:String!,$name:String!,$number:Int!){
 *       repository(owner:$owner,name:$name){ pullRequest(number:$number){
 *         number state isDraft mergeStateStatus isInMergeQueue autoMergeRequest { mergeMethod }
 *       } }
 *     }' | jq '.data.repository.pullRequest' | node scripts/pr-delivery-state.mjs
 *
 * Exit 0 when there is nothing to do (queued / closed), 1 when an action is
 * required (draft, red, not-queued, dead auto-merge request). The advice line
 * is the rule from docs/agents/gitops.md §9/§11.
 */
import { readFileSync } from "node:fs";
import {
  classifyDeliveryState,
  deliveryAdvice,
  deliveryExitCode,
} from "./prDeliveryState.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** `checksGreen` is derived by the caller shape; accept a boolean if present. */
function normalize(raw) {
  const pr = raw?.data?.repository?.pullRequest ?? raw;
  if (!pr || typeof pr !== "object") return null;
  return {
    ...pr,
    checksGreen:
      typeof pr.checksGreen === "boolean"
        ? pr.checksGreen
        : pr.mergeStateStatus === "DIRTY" || pr.mergeStateStatus === "BLOCKED"
          ? false
          : true,
  };
}

const input = process.argv[2] && process.argv[2] !== "-"
  ? readFileSync(process.argv[2], "utf8")
  : readStdin();

let parsed = null;
try {
  parsed = JSON.parse(input);
} catch {
  console.error(
    "pr-delivery-state: expected JSON (gh pr view --json … or the GraphQL pullRequest object)",
  );
  process.exit(2);
}

const pr = normalize(parsed);
if (!pr) {
  console.error("pr-delivery-state: no pull request object in the payload");
  process.exit(2);
}

const state = classifyDeliveryState(pr);
console.log(`${pr.number ? `#${pr.number}: ` : ""}${state} — ${deliveryAdvice(state, pr.number)}`);
process.exit(deliveryExitCode(state));
