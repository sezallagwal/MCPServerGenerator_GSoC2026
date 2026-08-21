import type { OpenAPIV3 } from "openapi-types";
import { resolveOperationId } from "../utils/resolve-operation-id.js";
import {
  extractCompactEndpoints,
  extractEndpointByLocation,
  extractFullEndpoints,
} from "./endpoint-extraction.js";
import { OpenApiSpecSource } from "./spec-source.js";
import type {
  CompactEndpoint,
  Domain,
  FullEndpoint,
  GetFullEndpointsResult,
  OperationLocation,
  SpecParserInterface,
  SpecParserOptions,
  SpecSource,
} from "./types.js";
import { ParserError, VALID_DOMAINS } from "./types.js";

export interface FuzzyMatchContext {
  missingIds: Set<string>;
  domainsToSearch: readonly Domain[];
  specs: OpenAPIV3.Document[];
  resultIds: Set<string>;
  maxDepth?: number;
}

export interface FuzzyMatchResult {
  additionalEndpoints: FullEndpoint[];
  correctedIds: Map<string, string>;
}

export function resolveMissingOperationIds(
  ctx: FuzzyMatchContext,
): FuzzyMatchResult {
  const { missingIds, domainsToSearch, specs, resultIds, maxDepth } = ctx;
  const correctedIds = new Map<string, string>();

  const candidateIdsByDomain: string[][] = [];
  for (let i = 0; i < domainsToSearch.length; i++) {
    const compacts = extractCompactEndpoints(specs[i], domainsToSearch[i]);
    candidateIdsByDomain.push(compacts.map((c) => c.operationId));
  }

  const matchedIdsByDomain = new Map<Domain, Set<string>>();
  const fuzzyMatchedIds = new Set<string>();
  const addMatch = (domain: Domain, requestedId: string, actualId: string) => {
    if (resultIds.has(actualId) || fuzzyMatchedIds.has(actualId)) {
      if (requestedId !== actualId) correctedIds.set(requestedId, actualId);
      return;
    }

    let ids = matchedIdsByDomain.get(domain);
    if (!ids) {
      ids = new Set<string>();
      matchedIdsByDomain.set(domain, ids);
    }
    ids.add(actualId);
    fuzzyMatchedIds.add(actualId);
    if (requestedId !== actualId) correctedIds.set(requestedId, actualId);
  };

  for (const missingId of missingIds) {
    for (let i = 0; i < domainsToSearch.length; i++) {
      const match = resolveOperationId(missingId, candidateIdsByDomain[i]);
      if (!match) continue;
      addMatch(domainsToSearch[i], missingId, match.matched);
      break;
    }
  }

  const additionalEndpoints: FullEndpoint[] = [];
  for (let i = 0; i < domainsToSearch.length; i++) {
    const ids = matchedIdsByDomain.get(domainsToSearch[i]);
    if (!ids?.size) continue;

    const extracted = extractFullEndpoints(
      specs[i],
      domainsToSearch[i],
      ids,
      maxDepth,
    );
    for (const ep of extracted) {
      if (resultIds.has(ep.operationId)) continue;
      additionalEndpoints.push(ep);
      resultIds.add(ep.operationId);
    }
  }

  return { additionalEndpoints, correctedIds };
}

/** Checked rather than cast: an unknown domain is a caller mistake worth naming. */
export function assertDomains(domains: readonly string[]): Domain[] {
  const narrowed: Domain[] = [];
  for (const domain of domains) {
    if (!VALID_DOMAINS.includes(domain as Domain)) {
      throw new ParserError(
        `Invalid domain: "${domain}". Valid domains: ${VALID_DOMAINS.join(", ")}`,
      );
    }
    narrowed.push(domain as Domain);
  }
  return narrowed;
}

export class SpecParser implements SpecParserInterface {
  private specSource: SpecSource;
  private domainIndex = new Map<string, OperationLocation>();

  constructor(options: SpecParserOptions = {}) {
    this.specSource =
      options.specSource ??
      new OpenApiSpecSource({
        cacheDir: options.cacheDir,
        cacheTtlMs: options.cacheTtlMs,
        fallbackCacheDirs: options.fallbackCacheDirs,
      });
  }

  async listEndpoints(
    requested: readonly string[],
  ): Promise<CompactEndpoint[]> {
    const domains = assertDomains(requested);

    const specs = await Promise.all(
      domains.map((d) => this.specSource.getSpec(d)),
    );

    const results: CompactEndpoint[] = [];
    for (let i = 0; i < domains.length; i++) {
      const extracted = extractCompactEndpoints(specs[i], domains[i]);
      for (const ep of extracted) {
        this.domainIndex.set(ep.operationId, {
          domain: ep.domain,
          path: ep.path,
          method: ep.method,
        });
      }
      results.push(...extracted);
    }

    return results;
  }

  async getFullEndpoints(
    operationIds: string[],
    requestedDomains?: readonly string[],
    maxDepth?: number,
  ): Promise<GetFullEndpointsResult> {
    const domains =
      requestedDomains === undefined
        ? undefined
        : assertDomains(requestedDomains);
    const correctedIds = new Map<string, string>();
    if (operationIds.length === 0) {
      return { endpoints: [], correctedIds };
    }

    const idSet = new Set(operationIds);
    const results: FullEndpoint[] = [];
    const resultIds = new Set<string>();
    const unindexedIds = new Set<string>();
    const specCache = new Map<Domain, OpenAPIV3.Document>();

    for (const id of idSet) {
      const loc = this.domainIndex.get(id);
      if (!loc) {
        unindexedIds.add(id);
        continue;
      }
      if (domains && !domains.includes(loc.domain)) continue;

      let spec = specCache.get(loc.domain);
      if (!spec) {
        spec = await this.specSource.getSpec(loc.domain);
        specCache.set(loc.domain, spec);
      }

      const ep = extractEndpointByLocation(
        spec,
        loc.domain,
        id,
        loc.path,
        loc.method,
        maxDepth,
      );
      if (ep) {
        results.push(ep);
        resultIds.add(ep.operationId);
      } else {
        unindexedIds.add(id);
      }
    }

    if (unindexedIds.size > 0) {
      const domainsToSearch: readonly Domain[] = domains ?? VALID_DOMAINS;
      const specs: OpenAPIV3.Document[] = [];
      for (const domain of domainsToSearch) {
        let spec = specCache.get(domain);
        if (!spec) {
          spec = await this.specSource.getSpec(domain);
          specCache.set(domain, spec);
        }
        specs.push(spec);
      }

      for (let i = 0; i < domainsToSearch.length; i++) {
        const extracted = extractFullEndpoints(
          specs[i],
          domainsToSearch[i],
          unindexedIds,
          maxDepth,
        );
        for (const ep of extracted) {
          if (resultIds.has(ep.operationId)) continue;
          results.push(ep);
          resultIds.add(ep.operationId);
          unindexedIds.delete(ep.operationId);
        }
        if (unindexedIds.size === 0) break;
      }

      if (unindexedIds.size > 0) {
        const fuzzyResult = resolveMissingOperationIds({
          missingIds: unindexedIds,
          domainsToSearch,
          specs,
          resultIds,
          maxDepth,
        });
        results.push(...fuzzyResult.additionalEndpoints);
        for (const [requestedId, actualId] of fuzzyResult.correctedIds) {
          correctedIds.set(requestedId, actualId);
        }
      }
    }

    return { endpoints: results, correctedIds };
  }

  getAvailableDomains(): Domain[] {
    return [...VALID_DOMAINS];
  }

  async getSpecStats(): Promise<{
    totalEndpoints: number;
    totalSchemaBytes: number;
  }> {
    const allEndpoints = await this.listEndpoints(VALID_DOMAINS);
    const specs = await Promise.all(
      VALID_DOMAINS.map((d) => this.specSource.getSpec(d)),
    );
    const totalSchemaBytes = specs.reduce(
      (sum, spec) => sum + JSON.stringify(spec).length,
      0,
    );
    return { totalEndpoints: allEndpoints.length, totalSchemaBytes };
  }
}
