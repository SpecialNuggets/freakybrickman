const { Innertube, Platform } = require("youtubei.js");
const { SlashCommandBuilder } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
} = require("@discordjs/voice");

const scdl = require("soundcloud-downloader").default;

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
        .setDescription(
          "the service to search from, youtube, soundcloud, or spotify.",
        ),
    ),
  async execute(interaction, client) {
    await interaction.deferReply();
    Platform.shim.eval = async (data) => {
      return new Function(data.output)();
    };
    const innertube = await Innertube.create({
      cookie: process.env.COOKIE,
    });
    const services = {
      soundcloud: async (query, clientId) => {
        return await scdl.search({ query: query, clientId: clientId });
      },
      youtube: async (query) => {
        return await innertube.search(query);
      },
    };
    const scdl_client_id = process.env.SCDL_CLIENT_ID;
    const service = interaction.options?.getString("service") || "youtube";
    if (!services?.[service])
      return await interaction.followUp("service is not supported.");
    const query = await services[service](
      interaction.options.getString("query"),
      scdl_client_id,
    );

    const channelId = interaction.member.voice?.channelId;
    const guildId = interaction.guildId;

    if (!channelId)
      return await interaction.followUp("Please join a voice channel first");

    const vad = interaction.guild.voiceAdapterCreator;
    const audioPlayer = createAudioPlayer();
    let audioResource;
    const download = async (service) => {
      if (service === "soundcloud")
        return await scdl
          .download(query["collection"][0].permalink_url, scdl_client_id)
          .then((stream) => (audioResource = createAudioResource(stream)));
      else if (service === "youtube") {
        const filter = query["results"].filter(
          (query) => query["type"] === "Video",
        );
        return await innertube
          .download(filter[0]["video_id"])
          .then((stream) => (audioResource = createAudioResource(stream)));
      }
    };
    await download(service);
    joinVoiceChannel({
      channelId: channelId,
      guildId: guildId,
      adapterCreator: vad,
    }).subscribe(audioPlayer);
    audioPlayer.play(audioResource);
    await interaction.followUp(
      `Now playing ${interaction.options.getString("query")}`,
    );
  },
};
