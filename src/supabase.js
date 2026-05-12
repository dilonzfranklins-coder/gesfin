import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://hempdtwiezvunxuieqoq.supabase.co";
const supabaseAnonKey = "sb_publishable_hQiPxCaLyAf3KayV0R6JTw_Rbo6n4d5";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
