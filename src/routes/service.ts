import { routeRequestSchema, type RouteAgent, type RouteRecord, type RouteRepository } from "./types.ts";

export class RouteService {
  private readonly repository: RouteRepository;
  private readonly agent: RouteAgent;

  constructor(
    repository: RouteRepository,
    agent: RouteAgent,
  ) {
    this.repository = repository;
    this.agent = agent;
  }

  async create(input: unknown, signal?: AbortSignal): Promise<RouteRecord> {
    const request = routeRequestSchema.parse(input);
    const created = await this.repository.createRequest(request);
    try {
      const plan = await this.agent.generate(request, signal);
      return await this.repository.savePlan(created.id, plan);
    } catch (error) {
      await this.repository.failRequest(created.id, error instanceof Error ? error.message : "route generation failed");
      throw error;
    }
  }

  get(id: string): Promise<RouteRecord | null> {
    return this.repository.get(id);
  }
}
