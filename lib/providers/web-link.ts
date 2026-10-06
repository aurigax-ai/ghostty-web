import type { ILinkHandler } from '../interfaces';
import type { IBufferRange, ILink } from '../types';

/**
 * A link to a URI. With a host link handler the host decides what a click
 * does (and shows its own hover hint); without one, Ctrl/Cmd+click opens the
 * URI in a new window.
 */
export function webLink(
  uri: string,
  range: IBufferRange,
  handler: () => ILinkHandler | undefined
): ILink {
  return {
    text: uri,
    range,
    activate: (event) => {
      const host = handler();
      if (host) {
        host.activate(event, uri, range);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }
    },
    hover: (hovered) => {
      const host = handler();
      if (!host) return;
      const event = new MouseEvent(hovered ? 'mouseover' : 'mouseout');
      if (hovered) host.hover?.(event, uri, range);
      else host.leave?.(event, uri, range);
    },
  };
}
