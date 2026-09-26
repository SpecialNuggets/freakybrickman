const { SlashCommandBuilder } = require("discord.js");
const { getVoiceConnection } = require("@discordjs/voice");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("stop the music and leave the voice channel"),
  async execute(interaction) {
    const connection = getVoiceConnection(interaction.guildId);
    if (!connection)
      return await interaction.reply("Nothing is playing right now.");

    connection.state.subscription?.player.stop(true);
    connection.destroy();
    await interaction.reply("Stopped the music and left the voice channel.");
  },
};
