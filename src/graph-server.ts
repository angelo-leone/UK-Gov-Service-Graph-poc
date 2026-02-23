/**
 * graph-server.ts — UK Government Services Graph MCP Server
 *
 * A focused MCP server that exposes the UK government service graph to AI
 * agents. It is intentionally separate from the forms-registry server so it
 * can be registered independently in Claude Desktop.
 *
 * ─── PRIMITIVES ────────────────────────────────────────────────────────────
 *
 * TOOLS (what Claude calls at runtime)
 *   1. list_life_events    — discover the 13 supported life events
 *   2. plan_journey        — compute a full service journey (lean, with signals)
 *   3. get_service         — drill into a single service for full eligibility
 *
 * RESOURCES (static context Claude can read)
 *   graph://life-events    — all 13 life events with entry nodes
 *   graph://services/all   — all 96 services with complete eligibility data
 *
 * PROMPTS (pre-packaged conversation starters)
 *   journey_advisor        — end-to-end journey planning with eligibility awareness
 *   eligibility_check      — deep-dive into a single service's eligibility criteria
 *
 * ─── ELIGIBILITY SIGNAL LEGEND ─────────────────────────────────────────────
 *
 * plan_journey returns lean eligibility signals per service:
 *   universal:    true  → virtually anyone qualifies; no screening needed
 *   gated:        true  → only surface after confirming a prerequisite
 *   proactive:    true  → agent should volunteer proactively from context signals
 *   means_tested: true  → income / capital assessment required
 *
 * Full eligibility data (criteria, keyQuestions, autoQualifiers, exclusions,
 * evidenceRequired) is returned by get_service.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildJourney, getServiceWithContext } from './graph-engine.js';
import { LIFE_EVENTS, NODES } from './graph-data.js';


// ─── SERVER INITIALISATION ─────────────────────────────────────────────────────

const server = new McpServer({
  name: 'uk-services-graph',
  version: '1.0.0',
});


// ════════════════════════════════════════════════════════════════════════════
// TOOLS
// ════════════════════════════════════════════════════════════════════════════

// ── Tool 1: list_life_events ─────────────────────────────────────────────────
//
// The entry point. Returns all 13 life events with their IDs, so the agent can
// identify which events match the user's situation before calling plan_journey.

server.tool(
  'list_life_events',
  `List all 13 UK government life events supported by the journey planner.

Each life event is a named entry point into the service graph. Call this first to ground the conversation in the available taxonomy, then identify which event(s) match the user's situation and call plan_journey.

Life events can be combined — someone having a baby who also just lost their job should use ["baby", "job-loss"] together. The graph deduplicates shared services across events.`,
  {},
  async () => {
    const events = LIFE_EVENTS.map(evt => ({
      id:             evt.id,
      name:           evt.name,
      description:    evt.desc,
      entryNodeCount: evt.entryNodes.length,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify(events, null, 2) }],
    };
  }
);


// ── Tool 2: plan_journey ─────────────────────────────────────────────────────
//
// The core journey planner. Returns services grouped into ordered phases, each
// with lean eligibility signals. These signals tell the agent how to present
// each service:
//
//   universal:true   → include without asking screening questions
//   proactive:true   → volunteer even if the user didn't ask
//   gated:true       → hold back until prerequisite confirmed
//   means_tested:true → flag that income/savings assessment is required
//
// For the full eligibility criteria (keyQuestions, autoQualifiers, exclusions,
// evidenceRequired) call get_service for any service the user asks about.

server.tool(
  'plan_journey',
  `Compute a personalised government service journey for one or more life events.

Returns services grouped into phases:
- Phase 1 = gateway services that must happen first (e.g. registering a birth or death)
- Later phases = services that are unlocked by earlier ones

Each service includes eligibility signals:
  universal      — true means virtually anyone qualifies; no screening needed
  proactive      — true means proactively mention this from context clues
  gated          — true means only surface after confirming a prerequisite
  means_tested   — true means income/capital assessment required
  eligibilitySummary — one-sentence plain-English eligibility description

Use the triggeredBy field to explain why each service appears. Use deadline to highlight urgency. Call get_service for any service the user wants to explore in depth.`,
  {
    life_event_ids: z.array(z.string()).min(1).describe(
      'One or more life event IDs from list_life_events (e.g. ["baby", "moving"] or ["bereavement"]). Multiple IDs are merged into a single journey, deduplicating shared services.'
    ),
  },
  async ({ life_event_ids }) => {
    const validIds = new Set(LIFE_EVENTS.map(e => e.id));
    const unknown  = life_event_ids.filter(id => !validIds.has(id));
    if (unknown.length) {
      return {
        content: [{
          type: 'text',
          text: `Unknown life event IDs: ${unknown.join(', ')}. Call list_life_events to see valid IDs.`,
        }],
      };
    }
    const result = buildJourney(life_event_ids);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);


// ── Tool 3: get_service ──────────────────────────────────────────────────────
//
// Returns the full service node: description, deadline, govuk_url, serviceType,
// and the complete eligibility model:
//
//   summary          — one-sentence overview
//   universal        — true = almost anyone qualifies
//   criteria[]       — typed factors (age, income, disability, etc.) with descriptions
//   keyQuestions[]   — questions to ask to determine eligibility
//   autoQualifiers[] — conditions that make eligibility certain (skip further checks)
//   exclusions[]     — common reasons someone does NOT qualify
//   means_tested     — income/capital test required
//   evidenceRequired — documents and proof typically needed
//
// Also returns the service's position in the graph:
//   prerequisites — services that must be completed first (REQUIRES edges)
//   unlocks       — services this one enables
//   triggeredByEvents — which life events directly surface this service

server.tool(
  'get_service',
  `Get full details about a specific government service, including its complete eligibility model.

Returns:
- Service description, deadline, GOV.UK URL, and type classification
- Full eligibility: summary, criteria (typed factors), key questions to ask the user, auto-qualifiers (conditions that confirm eligibility immediately), common exclusions, and evidence required
- Graph position: prerequisite services, services this unlocks, and which life events trigger it

Use this when the user asks for more detail about a service, or when you need to assess their eligibility for it. The keyQuestions tell you exactly what to ask. The autoQualifiers let you confirm eligibility without interrogating the user further.`,
  {
    service_id: z.string().describe(
      'The service node ID (e.g. "dwp-pip", "gro-register-birth", "hmcts-probate"). These IDs appear in plan_journey results.'
    ),
  },
  async ({ service_id }) => {
    const service = getServiceWithContext(service_id);
    if (!service) {
      return {
        content: [{
          type: 'text',
          text: `No service found with ID: "${service_id}". IDs appear in plan_journey results. Use list_life_events + plan_journey to discover valid IDs.`,
        }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(service, null, 2) }],
    };
  }
);


// ════════════════════════════════════════════════════════════════════════════
// RESOURCES
// ════════════════════════════════════════════════════════════════════════════
//
// Resources are static context that can be attached to a conversation without
// the agent having to call a tool. Unlike tool results (which are generated
// on demand), resources are passive context — the user or client attaches them
// and Claude reads them as background knowledge.
//
// Two resources are registered:
//   graph://life-events    — the 13 life events (lightweight, useful for priming)
//   graph://services/all   — all 96 services with full eligibility data
//                            (large — attach selectively for eligibility work)


server.resource(
  'life-events',
  'graph://life-events',
  {
    description: 'All 13 UK government life events with their entry service nodes. Lightweight context for priming a conversation about which events apply.',
    mimeType: 'application/json',
  },
  async () => {
    const events = LIFE_EVENTS.map(evt => ({
      id:         evt.id,
      name:       evt.name,
      desc:       evt.desc,
      entryNodes: evt.entryNodes,
    }));
    return {
      contents: [{
        uri:      'graph://life-events',
        mimeType: 'application/json',
        text:     JSON.stringify(events, null, 2),
      }],
    };
  }
);


server.resource(
  'all-services',
  'graph://services/all',
  {
    description: 'All 96 UK government service nodes with complete eligibility data: criteria, key questions, auto-qualifiers, exclusions, and evidence required. Large resource — attach when doing detailed eligibility assessment work.',
    mimeType: 'application/json',
  },
  async () => {
    const services = Object.values(NODES).map(node => ({
      ...node,
      // Attach graph context: which life events directly enter via this node
      triggeredByEvents: LIFE_EVENTS
        .filter(evt => evt.entryNodes.includes(node.id))
        .map(evt => evt.id),
    }));
    return {
      contents: [{
        uri:      'graph://services/all',
        mimeType: 'application/json',
        text:     JSON.stringify(services, null, 2),
      }],
    };
  }
);


// ════════════════════════════════════════════════════════════════════════════
// PROMPTS
// ════════════════════════════════════════════════════════════════════════════

// ── Prompt 1: journey_advisor ────────────────────────────────────────────────
//
// A full end-to-end journey conversation. The agent discovers the relevant
// life events, plans the journey, and uses eligibility signals to present it
// clearly — surfacing universal services, flagging deadlines, holding back
// gated services until prerequisites are confirmed.

server.prompt(
  'journey_advisor',
  'Guide a citizen through the UK government services relevant to their life situation, presenting a personalised, prioritised journey with eligibility-aware framing.',
  {
    situation: z.string().describe(
      'Plain-English description of what the person is going through (e.g. "my husband just died", "I\'m having a baby and got made redundant", "I\'m turning 66 next month")'
    ),
  },
  ({ situation }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `You are a compassionate, knowledgeable UK government services advisor. Your job is to help citizens navigate the services relevant to their situation — clearly, in the right order, and with honest eligibility guidance.

A citizen has described their situation:

"${situation}"

─── YOUR APPROACH ────────────────────────────────────────────────────────────

Step 1 — Identify life events
Call list_life_events. Match the situation to one or more life event IDs. If it spans multiple events (e.g. bereavement + retirement), use all relevant IDs together in plan_journey.

Step 2 — Plan the journey
Call plan_journey with those IDs. Review the phases and eligibility signals before responding.

Step 3 — Present the journey using eligibility signals

Use these signals to shape your response:

• universal: true → include the service without asking screening questions. Frame it as "you'll need to do this."

• proactive: true → volunteer this service even if the user hasn't asked, if context signals suggest it applies (e.g. if they mention children, flag Child Benefit; if they mention a partner, flag Marriage Allowance).

• gated: true → only mention once its prerequisite is confirmed. Don't open with it. The requires[] field tells you what must come first.

• means_tested: true → flag clearly: "This benefit is means-tested — your income and savings will be assessed."

• deadline present → always highlight urgency. Missed deadlines = lost money.

Step 4 — Structure your response
- Start with any immediate/urgent actions (deadlines, Phase 1 services)
- Then walk through later phases logically
- Group related services by department where helpful
- Be warm — this person may be in a difficult situation

Step 5 — Drill into detail on request
If the user asks about a specific service, call get_service to get the full eligibility criteria. Use the keyQuestions to guide a natural conversation. If any autoQualifiers apply based on what you already know, confirm eligibility immediately without further interrogation.

─── TONE ────────────────────────────────────────────────────────────────────

Plain English. No jargon. Short sentences. Be honest about uncertainty ("you may be eligible", "this depends on..."). If something is optional or conditional, say so.`,
      },
    }],
  })
);


// ── Prompt 2: eligibility_check ──────────────────────────────────────────────
//
// Focused on a single service. The agent retrieves full eligibility data and
// walks through the criteria systematically, asking only the keyQuestions
// needed to make a clear eligibility determination.

server.prompt(
  'eligibility_check',
  'Assess whether a citizen is likely eligible for a specific government service, walking through the eligibility criteria conversationally.',
  {
    service_id: z.string().describe(
      'The service node ID to assess (e.g. "dwp-pip", "dwp-carers-allowance", "hmrc-marriage-allowance")'
    ),
    context: z.string().optional().describe(
      'Optional: anything already known about the person\'s situation that may be relevant to eligibility'
    ),
  },
  ({ service_id, context }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `You are a knowledgeable UK benefits and services advisor. Assess whether the citizen is likely eligible for the government service with ID: "${service_id}".

${context ? `What we already know about this person:\n"${context}"\n` : ''}

─── YOUR APPROACH ────────────────────────────────────────────────────────────

1. Call get_service("${service_id}") to retrieve the full eligibility model.

2. Check autoQualifiers first. If any apply based on what we already know, confirm eligibility immediately and explain what the person gets.

3. Check exclusions. If any clearly apply, explain the person is not eligible and suggest alternatives if the graph shows related services (see the unlocks[] field for what this leads to, and prerequisites[] for what comes before).

4. Work through the criteria[] one by one:
   - For each factor (age, income, disability, etc.) determine if it applies based on known context
   - Use keyQuestions to fill in any gaps — ask them naturally in conversation, not as a form
   - Stop asking once eligibility is clear (don't interrogate unnecessarily)

5. Give a clear verdict:
   LIKELY ELIGIBLE — explain what they get, next steps, and evidenceRequired
   POSSIBLY ELIGIBLE — explain what needs to be confirmed and how
   NOT ELIGIBLE — explain why, and flag any similar services they may qualify for instead

6. Always mention:
   - Whether it's means-tested (if so, rough thresholds)
   - Any deadline for claiming
   - The GOV.UK URL to apply

─── TONE ────────────────────────────────────────────────────────────────────

Conversational and warm. One or two questions at a time — not a rapid-fire questionnaire. If the person seems to qualify easily, get to the good news quickly. If it's complex, explain why.`,
      },
    }],
  })
);


// ─── START THE SERVER ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
