'use client';

/* eslint-disable @next/next/no-img-element */

import { useState } from 'react';

export const MENU_IMAGE_FALLBACK = '/placeholders/avenue.png';

export default function MenuItemImage({ src, alt = '', className, style, ...props }) {
  const actualSrc = typeof src === 'string' ? src.trim() : '';
  const [loadedSrc, setLoadedSrc] = useState('');
  const [failedSrc, setFailedSrc] = useState('');
  const showingActual = Boolean(actualSrc) && failedSrc !== actualSrc;
  const actualLoaded = showingActual && loadedSrc === actualSrc;
  const imageSrc = showingActual ? actualSrc : MENU_IMAGE_FALLBACK;

  function handleLoad() {
    if (showingActual) setLoadedSrc(actualSrc);
  }

  function handleError() {
    if (showingActual) {
      setFailedSrc(actualSrc);
      setLoadedSrc('');
    }
  }

  return (
    <img
      {...props}
      src={imageSrc}
      alt={alt}
      className={className}
      style={{
        ...style,
        ...(showingActual && !actualLoaded
          ? {
              backgroundImage: `url(${MENU_IMAGE_FALLBACK})`,
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              backgroundSize: 'cover',
            }
          : {}),
      }}
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}
