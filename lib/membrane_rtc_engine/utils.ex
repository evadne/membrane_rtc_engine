defmodule Membrane.RTC.Utils do
  @moduledoc false
  use OpenTelemetryDecorator
  require OpenTelemetry.Tracer, as: Tracer

  # This is workaround to make dialyzer happy.
  # In other case we would have to specify all possible CallbackContext types here.
  # Maybe membrane_core should have something like
  # @type Membrane.Pipeline.CallbackContxt.t() ::  CallbackContext.Notification.t()
  #  | CallbackContext.Other.t()
  #  | CallbackContext.PlaybackChange.t()
  #  | etc.
  # to make it easier to reference CallbackContext types.
  @type ctx :: any()

  defmacro find_child(ctx, pattern: pattern) do
    quote do
      unquote(ctx).children |> Map.keys() |> Enum.find(&match?(unquote(pattern), &1))
    end
  end

  defmacro filter_children(ctx, pattern: pattern) do
    quote do
      unquote(ctx).children |> Map.keys() |> Enum.filter(&match?(unquote(pattern), &1))
    end
  end

  @spec reduce_children(ctx :: ctx(), acc :: any(), fun :: fun()) ::
          any()
  def reduce_children(ctx, acc, fun) do
    ctx.children |> Map.keys() |> Enum.reduce(acc, fun)
  end

  @spec flat_map_children(ctx :: ctx(), fun :: fun()) :: [any()]
  def flat_map_children(ctx, fun) do
    ctx.children |> Map.keys() |> Enum.flat_map(fun)
  end

  @spec forward(
          child_name :: any(),
          msg :: any(),
          ctx :: ctx()
        ) :: [Membrane.Pipeline.Action.forward_t()]
  def forward(child_name, msg, ctx) do
    child = find_child(ctx, pattern: ^child_name)

    if child do
      [forward: {child_name, msg}]
    else
      []
    end
  end

  @spec send_if_not_nil(pid :: pid() | nil, msg :: any()) :: any()
  def send_if_not_nil(pid, msg) do
    if pid != nil do
      send(pid, msg)
    end
  end

  @spec create_otel_context(name :: String.t(), metadata :: [{atom(), any()}]) :: any()
  def create_otel_context(name, metadata \\ []) do
    metadata =
      [
        {:"library.language", :erlang},
        {:"library.name", :membrane_rtc_engine},
        {:"library.version", "server:#{Application.spec(:membrane_rtc_engine, :vsn)}"}
      ] ++ metadata

    root_span = Tracer.start_span(name)
    parent_ctx = Tracer.set_current_span(root_span)
    otel_ctx = OpenTelemetry.Ctx.attach(parent_ctx)
    OpenTelemetry.Span.set_attributes(root_span, metadata)
    OpenTelemetry.Span.end_span(root_span)
    OpenTelemetry.Ctx.attach(otel_ctx)

    [otel_ctx]
  end

  @spec generate_turn_credentials(binary(), binary()) :: {binary(), binary()}
  def generate_turn_credentials(name, secret) do
    duration =
      DateTime.utc_now()
      |> DateTime.to_unix()
      |> tap(fn unix_timestamp -> unix_timestamp + 24 * 3600 end)

    username = "#{duration}:#{name}"

    password =
      :crypto.mac(:hmac, :sha, secret, username)
      |> Base.encode64()

    {username, password}
  end

  #   def distributed_sink_name(src_node, dst_node, room_id),
  #   do: Enum.join([src_node, dst_node, room_id, :sink], ":")

  # def distributed_source_name(src_node, dst_node, room_id),
  #   do: Enum.join([src_node, dst_node, room_id, :source], ":")

  # def match_distributed_twins() do
  #   case :global.whereis_name(twin_name) do
  #     :undefined ->
  #       receive do
  #         {:twin_in_handle_prepared_to_playing, twin} ->
  #           {:ok, Map.put(state, :twin, twin)}
  #       after
  #         5_000 ->
  #           {{:error, :twin_distributed_endpoint_not_responding}, state}
  #       end

  #     twin when is_pid(twin) ->
  #       send(twin, {:twin_in_handle_prepared_to_playing, self()})
  #       {:ok, Map.put(state, :twin, twin)}
  # end
end
