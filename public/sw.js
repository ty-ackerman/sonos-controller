// Service Worker for handling local network image requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only handle image proxy requests that are for local network images
  if (url.pathname === '/api/image-proxy' && url.searchParams.has('url')) {
    const imageUrl = decodeURIComponent(url.searchParams.get('url'));
    const isLocalNetwork = /^(http:\/\/)?(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.0\.0\.1|localhost)/.test(imageUrl);
    
    if (isLocalNetwork && imageUrl.startsWith('http://')) {
      console.log('[SW] Intercepting local network image request:', imageUrl);
      // Intercept and fetch the local image directly
      // Service Workers can fetch HTTP from HTTPS pages (bypasses mixed content)
      event.respondWith(
        fetch(imageUrl, {
          mode: 'no-cors',
          cache: 'default'
        })
          .then(response => {
            console.log('[SW] Local image fetch response received');
            // Convert to blob and return as image
            return response.blob().then(blob => {
              console.log('[SW] Converting blob to response, size:', blob.size);
              return new Response(blob, {
                headers: {
                  'Content-Type': blob.type || 'image/jpeg',
                  'Cache-Control': 'public, max-age=3600',
                  'Access-Control-Allow-Origin': '*'
                }
              });
            });
          })
          .catch(error => {
            console.error('[SW] Failed to fetch local image:', error);
            // Return error response that client can handle
            return new Response(JSON.stringify({ error: 'Failed to fetch local image' }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json'
              }
            });
          })
      );
      return; // Don't let the request continue to the server
    }
  }
  
  // For all other requests, let them pass through normally
});

