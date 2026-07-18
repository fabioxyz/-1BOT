module.exports = {
  name: 'interactionCreate',
  once: false,
  async execute(interaction, client) {
    // Ignorar interações que não são comandos slash
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`❌ Comando não encontrado: ${interaction.commandName}`);
      return;
    }

    try {
      console.log(`📨 Comando recebido: /${interaction.commandName} por ${interaction.user.tag}`);
      await command.execute(interaction);
    } catch (error) {
      console.error(`❌ ERRO no comando /${interaction.commandName}:`, error);

      const errorReply = {
        content: '❌ Ocorreu um erro ao executar este comando. Tenta novamente mais tarde.',
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorReply);
      } else {
        await interaction.reply(errorReply);
      }
    }
  },
};
