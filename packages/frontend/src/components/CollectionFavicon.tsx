import React, { useState } from 'react';
import { getFaviconUrl, getWebDomainFromNsid } from '../logic/domain';
import { IconWorld } from '@tabler/icons-react';

interface CollectionFaviconProps {
  nsid?: string;
  domain?: string;
  size?: number;
  className?: string;
}

export const CollectionFavicon: React.FC<CollectionFaviconProps> = ({
  nsid,
  domain: directDomain,
  size = 18,
  className = '',
}) => {
  const [hasError, setHasError] = useState(false);
  const domain = directDomain || (nsid ? getWebDomainFromNsid(nsid) : '');

  if (!domain || hasError) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 shrink-0 ${className}`}
        style={{ width: size, height: size }}
      >
        <IconWorld size={Math.max(12, size - 4)} stroke={1.5} />
      </span>
    );
  }

  return (
    <img
      src={getFaviconUrl(domain, size * 2)}
      alt={domain}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setHasError(true)}
      className={`rounded shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
};

export default CollectionFavicon;
