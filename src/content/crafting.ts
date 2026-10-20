/** A recipe you haven't learned yet, at the hearth or the workshop bench: locked until its page is carried (content/crafting.json `found`). */
export const LOCKED_RECIPE = {
  tag: 'not learned yet',
  line: (found: string) => `You haven’t learned this recipe yet. ${found}.`,
} as const
