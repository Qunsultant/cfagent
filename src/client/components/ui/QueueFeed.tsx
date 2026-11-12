import React from "react";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { Stack } from "./Stack";
import { EmptyState } from "./EmptyState";

export interface QueueFeedItem {
  /** Stable key for the row (an approval id, a feed-entry id). */
  id: string;
  /** The row itself — the caller's content, rendered as-is. */
  content: React.ReactNode;
}

export interface QueueFeedProps {
  /** Heading for the feed (rendered through CardHeader). */
  title?: string;
  /** Right-side header content — usually a count or status. */
  meta?: React.ReactNode;
  /** The feed rows, in display order. */
  items?: QueueFeedItem[];
  /** Empty-state title (default "Nothing in the queue"). */
  emptyTitle?: string;
  /** Empty-state description. */
  emptyDescription?: string;
  /** Empty-state icon. */
  emptyIcon?: React.ReactNode;
  /** Empty-state call to action (usually a Button). */
  emptyAction?: React.ReactNode;
}

/**
 * QueueFeed (#3134, Part of #2150)
 * The queue-rail slot (design-system §1.6b slot 6): the closing
 * section below the workspace — queue, feed, approvals — as one
 * surface. A flat Card with a CardHeader (title + meta) and the rows
 * in a Stack; with no rows the EmptyState is the content (an empty
 * queue is information, not an absent slot). No outer margin — slot
 * spacing is the template's Stack gap. Pages migrate onto it in
 * Wave 1 (#3138–#3140); this slice builds the organism only.
 */
export function QueueFeed({
  title,
  meta,
  items = [],
  emptyTitle = "Nothing in the queue",
  emptyDescription,
  emptyIcon,
  emptyAction,
}: QueueFeedProps) {
  return (
    <Card className="ui-queue-feed">
      {(title || meta) && <CardHeader title={title} meta={meta} />}
      {items.length === 0 ? (
        <EmptyState
          icon={emptyIcon}
          title={emptyTitle}
          description={emptyDescription}
          action={emptyAction}
        />
      ) : (
        <Stack gap="2">
          {items.map((item) => (
            <div key={item.id}>{item.content}</div>
          ))}
        </Stack>
      )}
    </Card>
  );
}
