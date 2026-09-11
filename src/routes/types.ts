import { z } from "zod";

export const routeRequestSchema = z.strictObject({
  goal: z.string().trim().min(1).max(1000),
  background: z.string().trim().max(3000).optional(),
  job_description: z.string().trim().max(12000).optional(),
  profile: z.strictObject({
    grade: z.string().trim().max(100).optional(),
    major: z.string().trim().max(200).optional(),
    foundation: z.string().trim().max(1000).optional(),
    weekly_hours: z.number().int().min(1).max(80).optional(),
    deadline: z.string().trim().max(100).optional(),
  }).default({}),
});

export type RouteRequest = z.infer<typeof routeRequestSchema>;

export const routePlanSchema = z.strictObject({
  industry_profile: z.string().min(1).max(6000),
  summary: z.string().min(1).max(3000),
  capabilities: z.array(z.strictObject({
    name: z.string().min(1).max(200),
    type: z.enum(["foundation", "professional", "market"]),
    reason: z.string().min(1).max(1000),
  })).min(1).max(20),
  two_week_plan: z.array(z.strictObject({
    day: z.number().int().min(1).max(14),
    title: z.string().min(1).max(200),
    actions: z.array(z.string().min(1).max(1000)).min(1).max(5),
    acceptance: z.string().min(1).max(1000),
    hours: z.number().min(0.5).max(24),
  })).min(1).max(14),
  sources: z.array(z.strictObject({
    title: z.string().min(1).max(500),
    url: z.url({ protocol: /^https?$/ }),
    author: z.string().max(200),
    reason: z.string().min(1).max(1000),
  })).max(10),
});

export type RoutePlan = z.infer<typeof routePlanSchema>;

export type RouteRecord = {
  id: string;
  status: "processing" | "completed" | "failed";
  request: RouteRequest;
  plan?: RoutePlan;
  error?: string;
  created_at: string;
};

export interface RouteAgent {
  generate(input: RouteRequest, signal?: AbortSignal): Promise<RoutePlan>;
}

export interface RouteRepository {
  createRequest(input: RouteRequest): Promise<{ id: string; created_at: string }>;
  savePlan(id: string, plan: RoutePlan): Promise<RouteRecord>;
  failRequest(id: string, message: string): Promise<void>;
  get(id: string): Promise<RouteRecord | null>;
}
