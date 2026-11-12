import React from "react";
import { Flex } from "./Flex";

export interface ActionBarProps {
  /** The page's primary action(s) — pushed right. */
  primary?: React.ReactNode;
  /** Secondary action(s) — read first, on the left. */
  secondary?: React.ReactNode;
}

/**
 * ActionBar (#3134, Part of #2150)
 * The action-bar slot (design-system §1.6b slot 5): the primary
 * actions for the page in one placement — the closing actions bar,
 * after the workspace and before the queue rail. Secondary actions
 * read first on the left; the primary action(s) are pushed right
 * with .ui-push. Built from Button (callers pass Buttons) in a Flex
 * row — the bar itself renders no controls. Renders nothing with
 * neither action (§1.6b slot rule). No outer margin — slot spacing
 * is the template's Stack gap; actions wrap on compact screens.
 * Pages migrate onto it in Wave 1 (#3138–#3140); this slice builds
 * the organism only.
 */
export function ActionBar({ primary, secondary }: ActionBarProps) {
  if (!primary && !secondary) return null;
  return (
    <Flex gap="2" align="center" className="ui-action-bar">
      {secondary}
      {primary && <span className="ui-push">{primary}</span>}
    </Flex>
  );
}
