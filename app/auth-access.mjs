// Only an authenticated user with a server-authorized membership can access the shared archive.
export async function inspectAccess(client) {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw new Error("No se pudo recuperar la sesión.");
  if (!sessionData?.session) return { state: "signed-out" };
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user?.id) throw new Error("No se pudo verificar la identidad con Supabase.");
  const { data: rows, error: membershipError } = await client.from("archive_members")
    .select("archive_id,role").eq("user_id",data.user.id);
  if (membershipError) throw new Error("No se pudo consultar la autorización.");
  if (!Array.isArray(rows) || rows.length !== 1 ||
      !["owner","editor"].includes(rows[0].role) || !rows[0].archive_id)
    return { state: "denied" };
  return { state: "authorized", role: rows[0].role, archiveId: rows[0].archive_id, userId: data.user.id };
}
