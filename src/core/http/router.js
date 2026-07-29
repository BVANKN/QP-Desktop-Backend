// Tiny exact-match + parameterized router over node:http. Routes register as
// (method, pathPattern, ...handlers). Patterns support `:param` segments.
export class Router {
  constructor() {
    this.routes = [];
  }

  register(method, pattern, ...handlers) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method: method.toUpperCase(), segments, handlers });
  }

  get(pattern, ...handlers) { this.register('GET', pattern, ...handlers); }
  post(pattern, ...handlers) { this.register('POST', pattern, ...handlers); }
  put(pattern, ...handlers) { this.register('PUT', pattern, ...handlers); }
  delete(pattern, ...handlers) { this.register('DELETE', pattern, ...handlers); }

  // Returns { handlers, params } or null. Also reports whether the path
  // exists under a different method so callers can send 405 vs 404.
  match(method, pathname) {
    const pathSegments = pathname.split('/').filter(Boolean);
    let pathExists = false;
    for (const route of this.routes) {
      if (route.segments.length !== pathSegments.length) continue;
      const params = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const routeSegment = route.segments[index];
        if (routeSegment.startsWith(':')) {
          params[routeSegment.slice(1)] = decodeURIComponent(pathSegments[index]);
        } else if (routeSegment !== pathSegments[index]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      pathExists = true;
      if (route.method === method.toUpperCase()) return { handlers: route.handlers, params };
    }
    return pathExists ? { methodMismatch: true } : null;
  }
}
