// Nombre de archivo de cada jugador: "ONU ElSeñorPipex#TLP" -> "onu-elsenorpipex-tlp".
export const slugOf = (riotId) =>
  riotId.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
