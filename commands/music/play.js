const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Innertube, Platform } = require("youtubei.js");
const { SlashCommandBuilder } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
} = require("@discordjs/voice");

const scdl = require("soundcloud-downloader").default;

// youtubei.js needs a JS evaluator to decipher YouTube stream URLs.
// The player script it hands us defines a `process(n, sp, sig)` function;
// we must call it and return its `{ n, sig }` result. (18.1.0+ appends the
// call itself; 18.0.0 does not, so add it when it's missing.)
Platform.shim.eval = (data, env) => {
  let code = data.output;
  if (!/return process\(/.test(code)) {
    code += `\nreturn process(${JSON.stringify(env.n || "")}, ${JSON.stringify(
      env.sp || "",
    )}, ${JSON.stringify(env.sig || "")});`;
  }
  return new Function(code)();
};

// Optional HTTP proxy for YouTube only (PROXY or YT_PROXY=http://user:pass@host:port).
// Datacenter IPs (like Oracle Cloud) often get "Sign in to confirm you're
// not a bot"; a residential proxy and/or COOKIE fixes that.
const YT_PROXY = process.env.YT_PROXY || process.env.PROXY;
let ytFetch;
if (YT_PROXY) {
  const { fetch, ProxyAgent } = require("undici");
  const dispatcher = new ProxyAgent(YT_PROXY);
  ytFetch = (input, init = {}) => {
    const url =
      typeof input === "string" || input instanceof URL ? input : input.url;
    const method = init.method || input?.method || "GET";
    return fetch(url, { ...init, method, dispatcher });
  };
}

// Create the YouTube session once and reuse it (it's slow to create).
let innertubePromise;
const getInnertube = () => {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      cookie: process.env.COOKIE,
      retrieve_player: true,
      ...(ytFetch ? { fetch: ytFetch } : {}),
    }).catch((err) => {
      innertubePromise = undefined; // allow retry next time
      throw err;
    });
  }
  return innertubePromise;
};

// YouTube audio is downloaded with yt-dlp: YouTube now rejects most direct
// stream requests that lack anti-bot tokens, which yt-dlp handles for us.
// Install: curl -L -o ~/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x ~/bin/yt-dlp
const YTDLP =
  process.env.YTDLP_PATH ||
  [path.join(os.homedir(), "bin", "yt-dlp"), "/usr/local/bin/yt-dlp"].find(
    (p) => fs.existsSync(p),
  ) ||
  "yt-dlp";

function ytdlpStream(videoId) {
  return new Promise((resolve, reject) => {
    const args = [
      "--js-runtimes",
      `node:${process.execPath}`,
      "-f",
      "bestaudio/best",
      "--no-playlist",
      "-q",
      "--no-warnings",
      "-o",
      "-",
    ];
    if (YT_PROXY) args.push("--proxy", YT_PROXY);
    args.push("--", `https://www.youtube.com/watch?v=${videoId}`);

    const proc = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let started = false;
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) =>
      reject(new Error(`Couldn't run yt-dlp (${YTDLP}): ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (!started)
        reject(
          new Error(stderr.trim().split("\n").pop() || `yt-dlp exited ${code}`),
        );
    });
    // Only report success once audio actually starts flowing.
    proc.stdout.once("readable", () => {
      if (proc.stdout.readableLength === 0) return; // EOF with no audio
      started = true;
      proc.stdout.once("close", () => proc.kill());
      resolve(proc.stdout);
    });
  });
}

// YouTube sometimes returns a one-off 403; retry once before giving up.
async function youtubeStream(videoId) {
  try {
    return await ytdlpStream(videoId);
  } catch (err) {
    if (/unavailable|private|removed|age/i.test(err.message)) throw err;
    return await ytdlpStream(videoId);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("play a song from a variety of sources")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("the song or video to look for")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("service")
        .setDescription("the service to search from")
        .addChoices(
          { name: "youtube", value: "youtube" },
          { name: "soundcloud", value: "soundcloud" },
        ),
    ),
  async execute(interaction) {
    await interaction.deferReply();

    const channelId = interaction.member.voice?.channelId;
    if (!channelId)
      return await interaction.followUp("Please join a voice channel first");

    const queryText = interaction.options.getString("query");
    const service = interaction.options.getString("service") || "youtube";
    const scdlClientId = process.env.SCDL_CLIENT_ID;

    let stream;
    let title = queryText;
    try {
      if (service === "soundcloud") {
        const results = await scdl.search({
          query: queryText,
          clientId: scdlClientId,
        });
        const track = results?.collection?.[0];
        if (!track) return await interaction.followUp("No results found.");
        title = track.title || title;
        stream = await scdl.download(track.permalink_url, scdlClientId);
      } else if (service === "youtube") {
        const innertube = await getInnertube();
        const search = await innertube.search(queryText, { type: "video" });
        const video = search.results?.find(
          (r) => r.type === "Video" && r.video_id,
        );
        if (!video) return await interaction.followUp("No results found.");
        title = video.title?.toString() || title;
        stream = await youtubeStream(video.video_id);
      } else {
        return await interaction.followUp("service is not supported.");
      }
    } catch (err) {
      console.error(`[play] ${service} failed:`, err);
      return await interaction.followUp(
        `Couldn't load that from ${service}: ${String(err?.message || err).slice(0, 1500)}`,
      );
    }

    const audioPlayer = createAudioPlayer();
    audioPlayer.on("error", (err) =>
      console.error("[play] audio player error:", err),
    );
    const connection = joinVoiceChannel({
      channelId,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
    });
    connection.subscribe(audioPlayer);
    audioPlayer.play(createAudioResource(stream));

    await interaction.followUp(`Now playing **${title}**`);
  },
};
