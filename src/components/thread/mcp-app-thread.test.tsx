import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { Message, ToolMessage } from "@langchain/langgraph-sdk";
import { ArtifactProvider } from "./artifact";
import { Thread } from "./index";

// How a report view sits in the real thread: <Thread> and <AssistantMessage>
// run as they are; only the stream (the messages), the thread list and the
// scroll container, which jsdom cannot lay out, are stand-ins.

const stream = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@/providers/Stream", () => ({
  useStreamContext: () => stream.current,
}));
vi.mock("@/providers/Thread", () => ({
  useThreads: () => ({ threads: [] }),
}));
vi.mock("./history", () => ({ default: () => null }));
vi.mock("use-stick-to-bottom", () => ({
  StickToBottom: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  useStickToBottomContext: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isAtBottom: true,
    scrollToBottom: () => {},
  }),
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  // jsdom has no matchMedia; <Thread> asks it whether the screen is large and
  // framer-motion (through the legacy listener API) whether to reduce motion.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

const VIEW_HTML =
  "<!doctype html><html><head><title>Stock Report</title></head><body></body></html>";
const VIEW = {
  html: VIEW_HTML,
  structuredContent: { kind: "stock_report", symbol: "INFY" },
  toolName: "render_stock_report",
  resourceUri: "ui://tradekit/stock-report-v3.html",
  title: null,
};

const question: Message = {
  type: "human",
  id: "human-1",
  content: "How is Infosys doing?",
};
// One AI message making an ordinary call and a report call side by side.
const calls: Message = {
  type: "ai",
  id: "ai-calls",
  content: "",
  tool_calls: [
    { id: "call_scan", name: "scan", args: { symbol: "INFY" } },
    {
      id: "call_report",
      name: "render_stock_report",
      args: { symbol: "INFY" },
    },
  ],
};
const scanResult: ToolMessage = {
  type: "tool",
  id: "tool-scan",
  tool_call_id: "call_scan",
  name: "scan",
  content: '{"hits": 3}',
};
const reportResult = (
  additional_kwargs?: Record<string, unknown>,
): ToolMessage => ({
  type: "tool",
  id: "tool-report",
  tool_call_id: "call_report",
  name: "render_stock_report",
  content: "Infosys summary for the model.",
  ...(additional_kwargs && { additional_kwargs }),
});
const reportWithView = reportResult({ mcp_app: VIEW });
const answer = (content = "Infosys looks steady."): Message => ({
  type: "ai",
  id: "ai-answer",
  content,
});

function showThread(
  messages: Message[],
  {
    hideToolCalls = false,
    isLoading = false,
    interrupt = undefined as unknown,
  } = {},
) {
  stream.current = {
    messages,
    values: { messages },
    isLoading,
    isThreadLoading: false,
    runStatus: isLoading ? "running" : "idle",
    requestApi: vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [] }), { status: 404 }),
      ),
    retry: vi.fn(),
    reloadConversation: vi.fn(),
    error: undefined,
    interrupt,
    getMessagesMetadata: () => undefined,
    setBranch: vi.fn(),
    submit: vi.fn(),
    stop: vi.fn(),
    // The server the app is connected to. Where the stream context carries
    // it, the thread header shows its host.
    apiUrl: "http://localhost:2024",
  };
  return (
    <NuqsTestingAdapter
      searchParams={hideToolCalls ? "?hideToolCalls=true" : ""}
    >
      <ArtifactProvider>
        <Thread />
      </ArtifactProvider>
    </NuqsTestingAdapter>
  );
}

// Mobile keeps the call inspectable and the rich report beside it.
const SCAN = "Scan the market";
const REPORT_CALL = "Build the stock report";
const accordions = () =>
  screen.queryAllByRole("button", { name: /expand tool call/i });
const view = () => screen.queryByTitle("Stock Report");
const follows = (later: Element, earlier: Element) =>
  !!(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
const fresh = (messages: Message[]): Message[] =>
  JSON.parse(JSON.stringify(messages));

beforeEach(() => {
  stream.current = undefined;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async () => new Response(new Uint8Array([0, 1, 2]))),
  );
});

describe("report views in the conversation", () => {
  const thread = [question, calls, scanResult, reportWithView, answer()];

  it("keeps each call inspectable and orders the report before the answer", async () => {
    render(showThread(thread));
    const iframe = await screen.findByTitle("Stock Report");
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(accordions()).toHaveLength(2);
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(follows(iframe, screen.getByText(SCAN))).toBe(true);
    expect(follows(screen.getByText("Infosys looks steady."), iframe)).toBe(
      true,
    );
  });

  it("keeps reports visible when raw tool details are hidden", async () => {
    render(showThread(thread, { hideToolCalls: true }));
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(screen.queryByText(SCAN)).not.toBeInTheDocument();
    expect(accordions()).toHaveLength(0);
  });

  it("renders an orphan report restored from history", async () => {
    render(showThread([question, reportWithView, answer()]));
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
  });

  it("keeps report and disclosure when a later placeholder answers the same call", async () => {
    const placeholder: ToolMessage = {
      type: "tool",
      id: "do-not-render-9",
      tool_call_id: "call_report",
      content: "Successfully handled tool call.",
    };
    render(showThread([...thread, placeholder]));
    expect(await screen.findByTitle("Stock Report")).toBeInTheDocument();
    expect(screen.getByText(REPORT_CALL)).toBeInTheDocument();
    expect(
      screen.queryByText("Successfully handled tool call."),
    ).not.toBeInTheDocument();
  });

  it("preserves the same frame as the answer streams and authoritative history arrives", async () => {
    const snapshot = (text?: string) =>
      fresh([
        question,
        calls,
        scanResult,
        reportWithView,
        ...(text ? [answer(text)] : []),
      ]);
    const { rerender } = render(showThread(snapshot(), { isLoading: true }));
    const iframe = (await screen.findByTitle(
      "Stock Report",
    )) as HTMLIFrameElement;
    await waitFor(() =>
      expect(iframe.srcdoc).toContain("<title>Stock Report</title>"),
    );
    const loaded = iframe.srcdoc;
    for (const text of ["Infosys", "Infosys looks", "Infosys looks steady."]) {
      rerender(showThread(snapshot(text), { isLoading: true }));
      expect(view()).toBe(iframe);
      expect(iframe.srcdoc).toBe(loaded);
    }
    rerender(showThread(snapshot("Infosys looks steady.")));
    expect(view()).toBe(iframe);
    expect(iframe.srcdoc).toBe(loaded);
  });

  it("pairs Anthropic content-block calls and retains the report", async () => {
    const streamed: Message = {
      type: "ai",
      id: "ai-calls",
      content: [
        { type: "tool_use", id: "call_scan", name: "scan", input: "{}" },
        {
          type: "tool_use",
          id: "call_report",
          name: "render_stock_report",
          input: '{"symbol":"INFY"}',
        },
      ],
      tool_calls: [],
    } as unknown as Message;
    const { rerender } = render(
      showThread([question, streamed, scanResult, reportWithView], {
        isLoading: true,
      }),
    );
    const iframe = await screen.findByTitle("Stock Report");
    expect(accordions()).toHaveLength(2);
    rerender(showThread(thread));
    expect(view()).toBe(iframe);
  });

  it("falls back to inspectable tool calls when a payload is malformed", () => {
    render(
      showThread([
        question,
        calls,
        scanResult,
        reportResult({ mcp_app: { html: "" } }),
        answer(),
      ]),
    );
    expect(accordions()).toHaveLength(2);
    expect(view()).not.toBeInTheDocument();
  });

  it("retains interrupts after reports at the end of the conversation", async () => {
    render(
      showThread([question, reportWithView], {
        interrupt: { value: { question: "Approve the order?" } },
      }),
    );
    const iframe = await screen.findByTitle("Stock Report");
    const interrupt = screen.getByRole("heading", { name: "Human Interrupt" });
    expect(follows(interrupt, iframe)).toBe(true);
  });
});
