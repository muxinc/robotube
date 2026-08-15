import { useAuthActions } from "@convex-dev/auth/react";
import {
  useAction,
  useConvexAuth,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Camera,
  Captions,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Compass,
  FileVideo2,
  Home,
  ImagePlus,
  LoaderCircle,
  Languages,
  LogOut,
  Menu,
  Play,
  Radio,
  Search,
  Send,
  Sparkles,
  Square,
  Upload,
  UserRound,
  Video,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";

import { VideoCard } from "./components/VideoCard";
import { categories } from "./data/categories";
import { api } from "./lib/convex";
import type { FeedVideoItem } from "./types";

const convexApi = api as any;
const MuxPlayer = lazy(() => import("@mux/mux-player-react"));

type LiveStream = {
  _id: string;
  title: string;
  muxLiveStreamId: string;
  playbackId: string | null;
  playbackUrl: string | null;
  thumbnailUrl?: string | null;
  status: "idle" | "active" | "disabled";
  channelName: string;
  channelAvatarUrl: string | null;
  createdAtMs: number;
};

type CurrentUser = {
  username?: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
};

const translationLanguages = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["ja", "Japanese"],
  ["zh", "Mandarin Chinese"],
] as const;

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — RoboTube`;
    return () => {
      document.title = "RoboTube — Video, understood";
    };
  }, [title]);
}

function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => setMobileMenuOpen(false), [location.pathname]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (value.length < 2) return;
    navigate(`/search?q=${encodeURIComponent(value)}`);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand" aria-label="RoboTube home">
            <img src="/images/robotube-logo.png" alt="RoboTube" />
          </Link>

          <form className="global-search" onSubmit={submitSearch} role="search">
            <Search size={19} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search videos, creators, or moments"
              aria-label="Search RoboTube"
            />
            <button type="submit" aria-label="Submit search">
              <ArrowUp size={17} />
            </button>
          </form>

          <nav className="desktop-nav" aria-label="Primary navigation">
            <NavLink to="/" end>
              <Home size={19} /> <span>Home</span>
            </NavLink>
            <NavLink to="/search">
              <Compass size={19} /> <span>Explore</span>
            </NavLink>
            <NavLink to="/upload" className="upload-link">
              <Upload size={18} /> <span>Upload</span>
            </NavLink>
            <NavLink to="/profile" aria-label="Profile">
              <CircleUserRound size={22} />
            </NavLink>
          </nav>

          <button
            className="mobile-menu-button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-label="Open navigation"
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        {mobileMenuOpen ? (
          <form className="mobile-search" onSubmit={submitSearch} role="search">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search RoboTube"
              autoFocus
              aria-label="Search RoboTube"
            />
          </form>
        ) : null}
      </header>

      <main className="main-content">{children}</main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        <NavLink to="/" end>
          <Home size={21} /> <span>Home</span>
        </NavLink>
        <NavLink to="/search">
          <Search size={21} /> <span>Explore</span>
        </NavLink>
        <NavLink to="/upload" className="bottom-nav__create">
          <Upload size={22} /> <span>Upload</span>
        </NavLink>
        <NavLink to="/profile">
          <UserRound size={21} /> <span>Profile</span>
        </NavLink>
      </nav>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow?: string;
  title: string;
  copy?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {copy ? <p>{copy}</p> : null}
      </div>
      {action}
    </div>
  );
}

function LoadingGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="video-grid" aria-label="Loading videos" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="video-skeleton" key={index}>
          <div className="skeleton-pulse" />
          <div className="video-skeleton__line" />
          <div className="video-skeleton__line video-skeleton__line--short" />
        </div>
      ))}
    </div>
  );
}

function LiveRail() {
  const streams = useQuery(convexApi.liveStreamQueries.listActiveLiveStreams, {}) as
    | LiveStream[]
    | undefined;

  if (!streams?.length) return null;

  return (
    <section className="live-section" aria-labelledby="live-heading">
      <div className="row-heading">
        <div>
          <span className="live-dot" />
          <h2 id="live-heading">Live now</h2>
        </div>
        <span>{streams.length} streaming</span>
      </div>
      <div className="live-rail">
        {streams.map((stream) => (
          <Link
            to={`/live/${encodeURIComponent(stream.muxLiveStreamId)}`}
            className="live-card"
            key={stream._id}
          >
            <div className="live-card__media">
              {stream.thumbnailUrl ? (
                <img src={stream.thumbnailUrl} alt="" />
              ) : (
                <div className="live-card__placeholder"><Radio size={28} /></div>
              )}
              <span className="live-badge"><span /> Live</span>
            </div>
            <div className="live-card__copy">
              <strong>{stream.title}</strong>
              <span>{stream.channelName}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function HomePage() {
  useDocumentTitle("Home");
  const { results, status, loadMore } = usePaginatedQuery(
    convexApi.feed.listFeedVideosPaginated,
    {},
    { initialNumItems: 12 },
  ) as {
    results: FeedVideoItem[];
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
    loadMore: (count: number) => void;
  };

  return (
    <div className="page page--home">
      <section className="home-intro">
        <div>
          <span className="eyebrow"><Sparkles size={14} /> Powered by Mux Robots</span>
          <h1>Video, understood.</h1>
          <p>Watch what’s new, jump to the moments that matter, and ask any video a question.</p>
        </div>
        <Link to="/search" className="button button--dark">
          Explore videos <ChevronRight size={18} />
        </Link>
      </section>

      <LiveRail />

      <section aria-labelledby="latest-heading">
        <div className="row-heading">
          <div><h2 id="latest-heading">Latest videos</h2></div>
          <span>Fresh from the community</span>
        </div>

        {status === "LoadingFirstPage" ? <LoadingGrid /> : null}
        {status !== "LoadingFirstPage" && results.length === 0 ? (
          <EmptyState
            icon={<Video size={29} />}
            title="The feed is warming up"
            copy="Upload the first video and RoboTube will take it from there."
            action={<Link className="button button--pink" to="/upload">Upload a video</Link>}
          />
        ) : null}
        {results.length > 0 ? (
          <div className="video-grid">
            {results.map((video) => <VideoCard video={video} key={video.muxAssetId} />)}
          </div>
        ) : null}
        {status === "CanLoadMore" || status === "LoadingMore" ? (
          <button
            className="button button--outline load-more"
            disabled={status === "LoadingMore"}
            onClick={() => loadMore(12)}
          >
            {status === "LoadingMore" ? <><LoaderCircle className="spin" size={17} /> Loading</> : "Load more"}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  copy,
  action,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h2>{title}</h2>
      <p>{copy}</p>
      {action}
    </div>
  );
}

function SearchPage() {
  useDocumentTitle("Explore");
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const query = initialQuery.trim();
  const results = useQuery(
    convexApi.searchFast.searchVideosFast,
    query.length >= 2 ? { queryText: query, limit: 30 } : "skip",
  ) as FeedVideoItem[] | undefined;

  return (
    <div className="page page--search">
      <SectionHeading
        eyebrow="Explore RoboTube"
        title={query ? `Results for “${query}”` : "What do you want to watch?"}
        copy={query ? "Matches across titles, summaries, and AI-generated tags." : "Use the search above or pick a lane."}
      />

      {!query ? (
        <section>
          <div className="row-heading"><div><h2>Browse by vibe</h2></div><span>Six ways in</span></div>
          <div className="category-grid">
            {categories.map((category) => (
              <button
                className="category-card"
                style={{ backgroundColor: category.color }}
                onClick={() => setSearchParams({ q: category.query })}
                key={category.label}
              >
                <img src={category.assetPath} alt="" />
                <span>{category.label}</span>
                <ChevronRight size={20} />
              </button>
            ))}
          </div>
        </section>
      ) : results === undefined ? (
        <LoadingGrid />
      ) : results.length > 0 ? (
        <div className="video-grid">
          {results.map((video) => <VideoCard video={video} key={video.muxAssetId} />)}
        </div>
      ) : (
        <EmptyState
          icon={<Search size={28} />}
          title="No videos found"
          copy="Try a broader phrase or browse one of the categories."
          action={<button className="button button--outline" onClick={() => setSearchParams({})}>Browse categories</button>}
        />
      )}
    </div>
  );
}

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function WatchPage() {
  const { muxAssetId = "" } = useParams();
  const decodedId = decodeURIComponent(muxAssetId);
  const video = useQuery(convexApi.feed.getFeedVideoByMuxAssetId, {
    muxAssetId: decodedId,
  }) as FeedVideoItem | null | undefined;
  const upNext = useQuery(convexApi.feed.listFeedVideos, { limit: 8 }) as
    | FeedVideoItem[]
    | undefined;
  const [tab, setTab] = useState<"overview" | "moments" | "chapters" | "ask">("overview");
  const playerRef = useRef<any>(null);

  useDocumentTitle(video?.title ?? "Watch");

  const seekTo = (seconds: number) => {
    if (playerRef.current) {
      playerRef.current.currentTime = seconds;
      void playerRef.current.play?.();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  if (video === undefined) {
    return <div className="page"><div className="watch-skeleton skeleton-pulse" /></div>;
  }
  if (video === null) {
    return (
      <div className="page">
        <EmptyState icon={<Video size={28} />} title="Video not found" copy="It may still be processing or is no longer public." action={<Link to="/" className="button button--outline">Back home</Link>} />
      </div>
    );
  }

  const suggestions = (upNext ?? []).filter((item) => item.muxAssetId !== video.muxAssetId).slice(0, 5);

  return (
    <div className="page page--watch">
      <Link className="back-link" to="/"><ArrowLeft size={17} /> Back to feed</Link>
      <div className="watch-layout">
        <div className="watch-main">
          <div className="player-frame">
            <Suspense fallback={<div className="player-loading"><LoaderCircle className="spin" /></div>}>
              <MuxPlayer
                ref={playerRef}
                playbackId={video.playbackId}
                metadata={{ video_id: video.muxAssetId, video_title: video.title, player_name: "RoboTube Web" }}
                accentColor="#FA50B5"
                streamType="on-demand"
                primaryColor="#ffffff"
                secondaryColor="#111111"
              />
            </Suspense>
          </div>
          <div className="watch-title-row">
            <div>
              <h1>{video.title}</h1>
              <p>{video.channelName}</p>
            </div>
            <div className="ai-chip"><Bot size={16} /> Mux Robots ready</div>
          </div>

          <div className="detail-tabs" role="tablist" aria-label="Video details">
            {([
              ["overview", "Overview", Sparkles],
              ["moments", "Key moments", Play],
              ["chapters", "Chapters", Clock3],
              ["ask", "Ask RoboTube", Bot],
            ] as const).map(([value, label, Icon]) => (
              <button
                role="tab"
                aria-selected={tab === value}
                className={tab === value ? "active" : ""}
                onClick={() => setTab(value)}
                key={value}
              >
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>

          <div className="detail-panel">
            {tab === "overview" ? (
              <div className="overview-panel">
                <span className="eyebrow">AI summary</span>
                <p>{video.summary || "RoboTube is still building a summary for this video."}</p>
                {video.tags.length ? <div className="tag-list">{video.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
              </div>
            ) : null}
            {tab === "moments" ? (
              <div className="moment-list">
                {video.keyMoments.length ? video.keyMoments.map((moment, index) => (
                  <button onClick={() => seekTo(moment.startMs / 1000)} key={`${moment.startMs}-${index}`}>
                    <span className="moment-list__time">{formatTime(moment.startMs / 1000)}</span>
                    <span><strong>{moment.title || `Moment ${index + 1}`}</strong><small>{moment.audibleNarrative || moment.visualNarrative || "Jump to this highlight."}</small></span>
                    <Play size={17} fill="currentColor" />
                  </button>
                )) : <EmptyInline copy="Key moments are still processing for this video." />}
              </div>
            ) : null}
            {tab === "chapters" ? (
              <div className="chapter-list">
                {video.chapters.length ? video.chapters.map((chapter, index) => (
                  <button onClick={() => seekTo(chapter.startTime)} key={`${chapter.startTime}-${index}`}>
                    <span>{formatTime(chapter.startTime)}</span><strong>{chapter.title}</strong><ChevronRight size={17} />
                  </button>
                )) : <EmptyInline copy="Chapters are still processing for this video." />}
              </div>
            ) : null}
            {tab === "ask" ? <VideoAssistant muxAssetId={video.muxAssetId} /> : null}
          </div>
        </div>

        <aside className="up-next">
          <div className="row-heading"><div><h2>Up next</h2></div></div>
          {suggestions.length ? suggestions.map((item) => <CompactVideo video={item} key={item.muxAssetId} />) : <p className="muted">More videos are on the way.</p>}
        </aside>
      </div>
    </div>
  );
}

function EmptyInline({ copy }: { copy: string }) {
  return <div className="empty-inline"><Bot size={24} /><p>{copy}</p></div>;
}

function CompactVideo({ video }: { video: FeedVideoItem }) {
  return (
    <Link to={`/watch/${encodeURIComponent(video.muxAssetId)}`} className="compact-video">
      <div><img src={video.thumbnailUrl} alt="" /><span><Play size={14} fill="currentColor" /></span></div>
      <p><strong>{video.title}</strong><small>{video.channelName}</small></p>
    </Link>
  );
}

function getMessageText(message: any) {
  if (Array.isArray(message?.parts)) {
    return message.parts.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("").trim();
  }
  return typeof message?.content === "string" ? message.content : "";
}

function VideoAssistant({ muxAssetId }: { muxAssetId: string }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const threadId = useQuery(
    convexApi.videoChat.getThreadForVideo,
    isAuthenticated ? { muxAssetId } : "skip",
  ) as string | null | undefined;
  const ensureThread = useMutation(convexApi.videoChat.ensureThreadForVideo);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) return <div className="chat-loading"><LoaderCircle className="spin" size={20} /> Loading assistant</div>;
  if (!isAuthenticated) {
    return <EmptyState icon={<Bot size={27} />} title="Ask this video anything" copy="Sign in to start a private conversation grounded in this video." action={<Link to="/profile" className="button button--pink">Sign in to ask</Link>} />;
  }
  if (threadId === undefined) return <div className="chat-loading"><LoaderCircle className="spin" size={20} /> Finding your thread</div>;
  if (threadId) return <ChatThread threadId={threadId} />;

  return (
    <div className="start-chat">
      <div className="robot-orb"><Bot size={28} /></div>
      <h3>Start with this video</h3>
      <p>RoboTube can answer questions using the summary, tags, chapters, and transcript context.</p>
      <button
        className="button button--pink"
        disabled={starting}
        onClick={async () => {
          setStarting(true);
          setError(null);
          try { await ensureThread({ muxAssetId }); }
          catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start the assistant."); }
          finally { setStarting(false); }
        }}
      >
        {starting ? <LoaderCircle className="spin" size={17} /> : <Bot size={17} />} Start conversation
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function ChatThread({ threadId }: { threadId: string }) {
  const { results, status, loadMore } = usePaginatedQuery(
    convexApi.videoChat.listThreadMessages,
    { threadId },
    { initialNumItems: 20 },
  ) as { results: any[]; status: string; loadMore: (count: number) => void };
  const sendMessage = useMutation(convexApi.videoChat.sendMessage);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight }), [results.length]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || sending) return;
    setDraft("");
    setSending(true);
    setError(null);
    try { await sendMessage({ threadId, prompt }); }
    catch (cause) { setDraft(prompt); setError(cause instanceof Error ? cause.message : "Could not send that message."); }
    finally { setSending(false); }
  };

  return (
    <div className="chat-thread">
      <div className="chat-messages" ref={messagesRef} aria-live="polite">
        {status === "CanLoadMore" || status === "LoadingMore" ? (
          <button className="chat-load-more" onClick={() => loadMore(12)}>{status === "LoadingMore" ? "Loading…" : "Load earlier messages"}</button>
        ) : null}
        {!results.length ? <div className="chat-welcome"><Bot size={25} /><p>Ask about a moment, topic, person, or idea in this video.</p></div> : null}
        {results.map((message, index) => {
          const user = message.role === "user";
          return <div className={`chat-bubble ${user ? "chat-bubble--user" : "chat-bubble--assistant"}`} key={message.id ?? index}>{getMessageText(message) || (user ? "Sent" : "Thinking…")}</div>;
        })}
      </div>
      <form className="chat-composer" onSubmit={submit}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask about this video…" maxLength={600} />
        <button type="submit" disabled={!draft.trim() || sending} aria-label="Send message"><Send size={18} /></button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function uploadFileWithProgress(url: string, file: File, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Mux upload failed (${request.status}).`)));
    request.addEventListener("error", () => reject(new Error("The upload connection was interrupted.")));
    request.send(file);
  });
}

function BrowserRecorder({
  stream,
  onCancel,
  onRecorded,
}: {
  stream: MediaStream;
  onCancel: () => void;
  onRecorded: (file: File) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const startRecording = () => {
    if (typeof MediaRecorder === "undefined") {
      setError("This browser does not support video recording.");
      return;
    }

    const mimeType = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));

    try {
      discardRef.current = false;
      chunksRef.current = [];
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        setRecording(false);
        if (discardRef.current || chunksRef.current.length === 0) return;
        const type = recorder.mimeType || "video/webm";
        const blob = new Blob(chunksRef.current, { type });
        const extension = type.includes("mp4") ? "mp4" : "webm";
        onRecorded(
          new File([blob], `robotube-recording-${Date.now()}.${extension}`, {
            type,
          }),
        );
      });
      recorder.start(500);
      setRecording(true);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start recording.",
      );
    }
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  };

  const cancel = () => {
    discardRef.current = true;
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
    onCancel();
  };

  return (
    <section className="browser-recorder" aria-label="Record a video">
      <video ref={videoRef} autoPlay muted playsInline />
      <div className="browser-recorder__status">
        {recording ? (
          <>
            <span /> Recording
          </>
        ) : (
          "Camera preview"
        )}
      </div>
      <div className="browser-recorder__actions">
        <button
          type="button"
          className="button button--outline"
          onClick={cancel}
        >
          Cancel
        </button>
        {recording ? (
          <button
            type="button"
            className="button button--pink"
            onClick={stopRecording}
          >
            <Square size={15} fill="currentColor" /> Stop and use video
          </button>
        ) : (
          <button
            type="button"
            className="button button--pink"
            onClick={startRecording}
          >
            <Camera size={17} /> Start recording
          </button>
        )}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

function UploadPage() {
  useDocumentTitle("Upload");
  const { isAuthenticated, isLoading } = useConvexAuth();
  const createUpload = useAction(convexApi.uploads.createMuxDirectUpload);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [audioLanguages, setAudioLanguages] = useState<string[]>([]);
  const [captionLanguages, setCaptionLanguages] = useState<string[]>([]);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [openingCamera, setOpeningCamera] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("Choose a video to begin.");
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );
  const moderation = useQuery(
    convexApi.uploadStatus.getUploadModerationStatus,
    uploadId ? { uploadId } : "skip",
  ) as
    | {
        done: boolean;
        progress: number;
        statusText: string;
        passed: boolean | null;
      }
    | undefined;

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  useEffect(
    () => () => cameraStream?.getTracks().forEach((track) => track.stop()),
    [cameraStream],
  );
  useEffect(() => {
    if (moderation) {
      setProgress(moderation.progress);
      setStatusText(moderation.statusText);
    }
  }, [moderation]);

  if (isLoading)
    return (
      <div className="page">
        <div className="chat-loading">
          <LoaderCircle className="spin" /> Loading
        </div>
      </div>
    );
  if (!isAuthenticated)
    return (
      <AuthGate
        title="Share your first video"
        copy="Sign in to upload directly to the same RoboTube library you use on mobile."
      />
    );

  const closeCamera = () => {
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
  };

  const openCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera recording is not available in this browser.");
      return;
    }

    setOpeningCamera(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: true,
      });
      setCameraStream(stream);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Camera and microphone access could not be started.",
      );
    } finally {
      setOpeningCamera(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !file || uploading) return;
    setUploading(true);
    setError(null);
    setUploadId(null);
    setProgress(4);
    setStatusText("Creating a secure Mux upload…");
    try {
      const result = (await createUpload({
        title: title.trim(),
        audioTranslationLanguageCodes: audioLanguages,
        captionTranslationLanguageCodes: captionLanguages,
      })) as { uploadId: string; uploadUrl: string };
      setProgress(10);
      setStatusText("Uploading your video…");
      await uploadFileWithProgress(result.uploadUrl, file, (fraction) =>
        setProgress(10 + Math.round(fraction * 83)),
      );
      setUploadId(result.uploadId);
      setProgress(95);
      setStatusText("Upload complete. Mux is processing and moderating it…");
      setTitle("");
      setFile(null);
    } catch (cause) {
      setProgress(0);
      setError(cause instanceof Error ? cause.message : "Upload failed.");
      setStatusText("Upload failed. Your video was not published.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="page page--narrow">
      <SectionHeading
        eyebrow="Creator studio"
        title="Upload a video"
        copy="Mux handles the stream. RoboTube generates the useful parts."
      />
      <form className="upload-form" onSubmit={submit}>
        <div className="media-source-actions">
          <button
            type="button"
            className="media-source-button"
            disabled={openingCamera || uploading || Boolean(cameraStream)}
            onClick={() => void openCamera()}
          >
            {openingCamera ? (
              <LoaderCircle className="spin" size={20} />
            ) : (
              <Camera size={20} />
            )}
            <span>
              <strong>Record video</strong>
              <small>Use your camera and microphone</small>
            </span>
          </button>
        </div>

        {cameraStream ? (
          <BrowserRecorder
            stream={cameraStream}
            onCancel={closeCamera}
            onRecorded={(recordedFile) => {
              setFile(recordedFile);
              closeCamera();
              setStatusText("Recorded video ready to upload.");
            }}
          />
        ) : null}

        <div
          className={`drop-zone ${file ? "drop-zone--selected" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const next = event.dataTransfer.files[0];
            if (next?.type.startsWith("video/")) setFile(next);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          {file && previewUrl ? (
            <>
              <video src={previewUrl} controls preload="metadata" />
              <button
                type="button"
                className="drop-zone__remove"
                onClick={() => setFile(null)}
                aria-label="Remove video"
              >
                <X size={18} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="drop-zone__prompt"
              onClick={() => inputRef.current?.click()}
            >
              <span>
                <FileVideo2 size={29} />
              </span>
              <strong>Drop a video here</strong>
              <small>or click to browse your device</small>
            </button>
          )}
        </div>

        <label className="field">
          <span>Video title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Give people a reason to press play"
            maxLength={120}
            required
          />
        </label>
        <div className="translation-grid">
          <fieldset className="translation-fieldset">
            <legend>
              <Languages size={17} /> Translated audio
            </legend>
            <p>Choose languages for dubbed audio tracks.</p>
            <div className="chip-list">
              {translationLanguages.map(([code, label]) => {
                const selected = audioLanguages.includes(code);
                return (
                  <button
                    type="button"
                    className={selected ? "selected" : ""}
                    aria-pressed={selected}
                    onClick={() =>
                      setAudioLanguages((current) =>
                        selected
                          ? current.filter((item) => item !== code)
                          : [...current, code],
                      )
                    }
                    key={code}
                  >
                    {selected ? <Check size={14} /> : null}
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="translation-fieldset">
            <legend>
              <Captions size={17} /> Translated captions
            </legend>
            <p>Choose subtitle languages independently from audio.</p>
            <div className="chip-list">
              {translationLanguages.map(([code, label]) => {
                const selected = captionLanguages.includes(code);
                return (
                  <button
                    type="button"
                    className={selected ? "selected" : ""}
                    aria-pressed={selected}
                    onClick={() =>
                      setCaptionLanguages((current) =>
                        selected
                          ? current.filter((item) => item !== code)
                          : [...current, code],
                      )
                    }
                    key={code}
                  >
                    {selected ? <Check size={14} /> : null}
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        {uploading || uploadId ? (
          <div className="upload-progress">
            <div>
              <span style={{ width: `${Math.max(progress, 2)}%` }} />
            </div>
            <p>
              <strong>{progress}%</strong>
              {statusText}
            </p>
          </div>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        <button
          className="button button--pink button--large"
          type="submit"
          disabled={!title.trim() || !file || uploading}
        >
          {uploading ? (
            <>
              <LoaderCircle className="spin" size={18} /> Uploading…
            </>
          ) : (
            <>
              <Upload size={18} /> Upload video
            </>
          )}
        </button>
      </form>
    </div>
  );
}

function AuthGate({ title, copy }: { title: string; copy: string }) {
  const { signIn } = useAuthActions();
  const [provider, setProvider] = useState<"google" | "apple" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async (next: "google" | "apple") => {
    setProvider(next); setError(null);
    try { await signIn(next, { redirectTo: window.location.href }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start sign in."); setProvider(null); }
  };
  return (
    <div className="page auth-page">
      <div className="auth-card">
        <img src="/images/app-icon.png" alt="" />
        <span className="eyebrow">Your RoboTube account</span>
        <h1>{title}</h1><p>{copy}</p>
        <button className="provider-button" disabled={provider !== null} onClick={() => void start("google")}>{provider === "google" ? <LoaderCircle className="spin" size={18} /> : <span className="provider-mark">G</span>} Continue with Google</button>
        <button className="provider-button provider-button--apple" disabled={provider !== null} onClick={() => void start("apple")}>{provider === "apple" ? <LoaderCircle className="spin" size={18} /> : <span className="provider-mark">●</span>} Continue with Apple</button>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </div>
  );
}

function ProfilePage() {
  useDocumentTitle("Profile");
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  const currentUser = useQuery(convexApi.users.currentUser, isAuthenticated ? {} : "skip") as CurrentUser | null | undefined;
  const uploads = useQuery(convexApi.feed.listCurrentUserUploadedVideos, isAuthenticated ? { limit: 24 } : "skip") as FeedVideoItem[] | undefined;
  const updateUsername = useMutation(convexApi.users.updateUsername);
  const generateAvatarUploadUrl = useMutation(convexApi.users.generateAvatarUploadUrl);
  const updateProfileImage = useMutation(convexApi.users.updateProfileImage);
  const [handle, setHandle] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  useEffect(() => setHandle(currentUser?.username ?? ""), [currentUser?.username]);

  if (isLoading) return <div className="page"><div className="chat-loading"><LoaderCircle className="spin" /> Loading profile</div></div>;
  if (!isAuthenticated) return <AuthGate title="Welcome back" copy="Sign in to upload videos, manage your profile, and talk to any video." />;
  if (currentUser === undefined) return <div className="page"><div className="chat-loading"><LoaderCircle className="spin" /> Loading profile</div></div>;

  const displayName = currentUser?.name || currentUser?.username || currentUser?.email?.split("@")[0] || "RoboTube creator";
  const initial = displayName.charAt(0).toUpperCase();

  const uploadAvatar = async (file: File) => {
    setSaving(true); setMessage(null);
    try {
      const { uploadUrl } = await generateAvatarUploadUrl({}) as { uploadUrl: string };
      const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type || "image/jpeg" }, body: file });
      if (!response.ok) throw new Error("Could not upload that image.");
      const result = await response.json() as { storageId: string };
      await updateProfileImage({ storageId: result.storageId });
      setMessage("Profile photo updated.");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not update your photo."); }
    finally { setSaving(false); }
  };

  return (
    <div className="page page--profile">
      <section className="profile-hero">
        <button className="profile-avatar" onClick={() => avatarInput.current?.click()} aria-label="Change profile photo">
          {currentUser?.avatarUrl ? <img src={currentUser.avatarUrl} alt="" /> : <span>{initial}</span>}
          <i><ImagePlus size={16} /></i>
        </button>
        <input ref={avatarInput} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); }} />
        <div className="profile-identity"><span className="eyebrow">Creator profile</span><h1>{displayName}</h1><p>{currentUser?.email}</p></div>
        <button className="button button--outline" onClick={() => void signOut()}><LogOut size={17} /> Sign out</button>
      </section>
      <section className="profile-settings">
        <div><h2>Public handle</h2><p>This is how your channel appears across RoboTube.</p></div>
        <form onSubmit={async (event) => { event.preventDefault(); setSaving(true); setMessage(null); try { const result = await updateUsername({ username: handle }) as { username: string }; setHandle(result.username); setMessage("Handle saved."); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not save your handle."); } finally { setSaving(false); } }}>
          <label><span>@</span><input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="your_handle" /></label>
          <button className="button button--dark" disabled={saving}>Save</button>
        </form>
        {message ? <p className="form-message">{message}</p> : null}
      </section>
      <section>
        <div className="row-heading"><div><h2>Your uploads</h2></div><span>{uploads?.length ?? 0} videos</span></div>
        {uploads === undefined ? <LoadingGrid count={3} /> : uploads.length ? <div className="video-grid">{uploads.map((video) => <VideoCard video={video} key={video.muxAssetId} />)}</div> : <EmptyState icon={<Upload size={28} />} title="Nothing here yet" copy="Your published videos will live here." action={<Link to="/upload" className="button button--pink">Upload a video</Link>} />}
      </section>
    </div>
  );
}

function LiveWatchPage() {
  const { muxLiveStreamId = "" } = useParams();
  const stream = useQuery(convexApi.liveStreamQueries.getLiveStreamByMuxId, { muxLiveStreamId: decodeURIComponent(muxLiveStreamId) }) as LiveStream | null | undefined;
  useDocumentTitle(stream?.title ?? "Live");
  if (stream === undefined) return <div className="live-watch"><LoaderCircle className="spin" size={28} /></div>;
  if (!stream) return <Navigate to="/" replace />;
  return (
    <div className="live-watch">
      <Link to="/" className="live-watch__back"><ArrowLeft size={18} /> Back</Link>
      <div className="live-watch__player">
        {stream.playbackId ? <Suspense fallback={<div className="player-loading"><LoaderCircle className="spin" /></div>}><MuxPlayer playbackId={stream.playbackId} streamType="live" autoPlay accentColor="#FA50B5" /></Suspense> : <div className="live-offline"><Radio size={34} /><h1>Waiting for the stream</h1></div>}
      </div>
      <div className="live-watch__info"><span className="live-badge"><span /> {stream.status === "active" ? "Live" : "Ended"}</span><div><h1>{stream.title}</h1><p>{stream.channelName}</p></div></div>
    </div>
  );
}

function NotFoundPage() {
  useDocumentTitle("Not found");
  return <div className="page"><EmptyState icon={<Compass size={28} />} title="That page wandered off" copy="Let’s get you back to the videos." action={<Link to="/" className="button button--pink">Go home</Link>} /></div>;
}

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/watch/:muxAssetId" element={<WatchPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/sign-in" element={<Navigate to="/profile" replace />} />
        <Route path="/live/:muxLiveStreamId" element={<LiveWatchPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
