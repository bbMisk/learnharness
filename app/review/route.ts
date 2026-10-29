export async function GET(request: Request) {
	return Response.redirect(new URL("/review/index.html", request.url), 307);
}
